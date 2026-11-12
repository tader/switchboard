import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { requireUser, requireAdmin, type Env } from '../auth.ts';
import { HttpError } from '../http.ts';
import { config } from '../config.ts';
import { bindTarget, eligible, runningBuild, selectTarget, type Channel, type Target } from './releases.ts';

export const protocol = 1;
export function ensureUpdateIdentity() {
  const p = path.join(config.dataDir, 'update-instance-id');
  try { fs.writeFileSync(p, randomUUID(), { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
}

export const lifecycle = { state: process.env.SWITCHBOARD_START_GATED === '1' ? 'staged' : 'starting', open: async () => {}, drain: async () => {} };
const file = () => path.join(config.dataDir, 'update-control.json');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export interface Job { id: string; target: Target; state: string; createdAt: number; cancel?: boolean; error?: string; durations?: Record<string, number> }
interface State { channel?: Channel; enrollment?: { hash: string; expires: number }; tokenHash?: string; paired?: { instance: string; mode: string; protocol: number; seen: number; sourceBuild?: boolean }; checkedAt?: number; attemptedAt?: number; target?: Target; error?: string; job?: Job }
function read(): State { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error('Updater state could not be read; owner recovery is required'); } }
function write(s: State) {
  const tmp = `${file()}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(s)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file());
  const dir = fs.openSync(config.dataDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
let checking: Promise<void> | undefined;
async function check(force = false) {
  if (checking) return checking;
  const s = read();
  if (!force && s.attemptedAt && Date.now() - s.attemptedAt < 86400_000) return;
  checking = (async () => {
    try { const build = runningBuild(); const target = await bindTarget(build, await selectTarget(s.channel ?? 'stable', build.mode, fetch, s.paired?.sourceBuild)); const current = read(); write({ ...current, target, checkedAt: Date.now(), attemptedAt: Date.now(), error: undefined }); }
    catch { write({ ...read(), target: undefined, attemptedAt: Date.now(), error: 'No compatible upgrade could be verified. The release may lack gated startup, its artifacts may still be publishing, or the release service may be unavailable.' }); }
  })().finally(() => { checking = undefined; });
  return checking;
}
export function startUpdateChecks() { if (process.env.SWITCHBOARD_UPDATE_CHECKS === 'false') return () => {}; void check().catch(() => {}); const timer = setInterval(() => { void check().catch(() => {}); }, 3600_000); timer.unref(); return () => clearInterval(timer); }
export const updates = new Hono<Env>();
updates.use('*', requireUser, requireAdmin);
updates.get('/', c => {
  const s = read(), build = runningBuild();
  return c.json({ build, channel: s.channel ?? 'stable', checkedAt: s.checkedAt, error: s.error, target: s.target, eligible: !!s.target && eligible(build, s.target), paired: !!s.paired && s.paired.protocol === protocol && Date.now() - s.paired.seen < 30_000 && s.paired.mode === build.mode, job: s.job });
});
updates.post('/check', async c => { await check(true); return c.json({ ok: true }); });
updates.put('/channel', async c => { if (checking) await checking; const { channel } = await c.req.json(); if (!['stable', 'validated-main'].includes(channel)) throw new HttpError(400, 'Invalid channel'); const s = read(); if (s.job && !terminal(s.job.state)) throw new HttpError(409, 'An upgrade is active'); write({ ...s, channel, target: undefined, attemptedAt: undefined }); await check(true); return c.json({ ok: true }); });
updates.post('/enrollment', c => {
  const s = read(); if (s.job && !terminal(s.job.state)) throw new HttpError(409, 'An upgrade is active');
  const code = randomBytes(32).toString('base64url'); write({ ...s, enrollment: { hash: hash(code), expires: Date.now() + 600_000 } }); return c.json({ code, expiresAt: Date.now() + 600_000 });
});
updates.delete('/enrollment', c => { const s = read(); if (s.job && !terminal(s.job.state)) throw new HttpError(409, 'An upgrade is active'); delete s.tokenHash; delete s.paired; delete s.enrollment; write(s); return c.json({ ok: true }); });
export function terminal(state: string) { return ['succeeded', 'rolled-back', 'failed', 'recovery-required', 'cancelled'].includes(state); }
updates.post('/jobs', c => {
  const s = read(), build = runningBuild();
  if (s.job && !terminal(s.job.state)) throw new HttpError(409, 'An upgrade is already active');
  if (!s.paired || s.paired.protocol !== protocol || s.paired.mode !== build.mode || Date.now() - s.paired.seen > 30_000) throw new HttpError(409, 'A compatible updater must be online');
  if (s.job?.state === 'recovery-required') throw new HttpError(409, 'Owner recovery is required before another upgrade');
  if (!s.target || !s.checkedAt || Date.now() - s.checkedAt > 86400_000 || !eligible(build, s.target)) throw new HttpError(409, 'No verified upgrade is available for this build');
  s.job = { id: randomBytes(16).toString('hex'), target: s.target, state: 'queued', createdAt: Date.now() }; write(s); return c.json(s.job, 202);
});
updates.post('/jobs/cancel', c => { const s = read(); if (!s.job || !['queued', 'preparing'].includes(s.job.state)) throw new HttpError(409, 'Cutover has started; cancellation is unavailable'); s.job.cancel = true; if (s.job.state === 'queued') s.job.state = 'cancelled'; write(s); return c.json({ ok: true }); });

// Dedicated credentials are never accepted by normal application authentication.
export const updaterApi = new Hono();
updaterApi.post('/enroll', async c => {
  const { code, instance, mode, sourceBuild, protocol: version } = await c.req.json(); const s = read();
  if (typeof code !== 'string' || !s.enrollment || s.enrollment.expires < Date.now() || hash(code) !== s.enrollment.hash) throw new HttpError(401, 'Invalid or expired enrollment');
  if (version !== protocol || typeof instance !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(instance) || !['checkout', 'compose', 'runtime'].includes(mode)) throw new HttpError(400, 'Incompatible updater');
  const token = `swbu_${randomBytes(32).toString('base64url')}`; delete s.enrollment; s.tokenHash = hash(token); s.paired = { instance, mode, protocol, sourceBuild: sourceBuild === true, seen: Date.now() }; write(s); return c.json({ token });
});
updaterApi.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /, ''), s = read();
  if (!token || !s.tokenHash || hash(token) !== s.tokenHash) throw new HttpError(401, 'Updater authentication required');
  await next();
});
updaterApi.post('/poll', async c => { const s = read(); if (!s.paired) throw new HttpError(401, 'Enroll updater'); s.paired.seen = Date.now(); write(s); return c.json({ protocol, instance: s.paired.instance, dataIdentity: fs.readFileSync(path.join(config.dataDir, 'update-instance-id'), 'utf8'), build: runningBuild(), job: s.job, lifecycle: lifecycle.state }); });
updaterApi.post('/report', async c => {
  const b = await c.req.json(), s = read();
  if (!s.job || s.job.id !== b.id) throw new HttpError(409, 'Unknown job');
  const states = ['preparing', 'draining', 'snapshot', 'starting', 'opening', 'succeeded', 'rolled-back', 'failed', 'recovery-required', 'cancelled'];
  if (!states.includes(b.state)) throw new HttpError(400, 'Invalid state');
  if (['preparing', 'draining'].includes(b.state) && s.job.cancel || s.job.state === 'cancelled' && b.state === 'failed') return c.json({ ok: true, cancel: true });
  s.job.state = b.state;
  // Never accept tool output, paths, commands or diagnostics from the controller into public UI.
  s.job.error = ['failed', 'recovery-required', 'rolled-back'].includes(b.state) ? b.state === 'failed' && b.reason === 'preflight' ? 'The updater could not validate the installation before starting. The server was left running. Check the updater logs and deployment configuration.' : 'Upgrade did not complete. Inspect the owner-only updater journal and follow the recovery guide.' : undefined;
  if (b.durations && typeof b.durations === 'object') s.job.durations = Object.fromEntries(Object.entries(b.durations).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0)) as Record<string, number>;
  write(s); return c.json({ ok: true, cancel: s.job.cancel });
});
updaterApi.post('/drain', async c => { await lifecycle.drain(); return c.json({ ok: true }); });
updaterApi.post('/open', async c => { await lifecycle.open(); return c.json({ ok: true }); });
updaterApi.get('/ready', c => c.json({ ready: ['staged', 'open'].includes(lifecycle.state), state: lifecycle.state, build: runningBuild() }));

/** Private parent-child IPC only; these credentials never authorize general APIs. */
export async function localUpdateControl(action: string) {
  if (action === 'status') { const s = read(); return { paired: !!s.paired, job: s.job, target: s.target, eligible: !!s.target && eligible(runningBuild(), s.target), build: runningBuild() }; }
  if (action === 'pair') {
    const s = read();
    const token = `swbu_${randomBytes(32).toString('base64url')}`;
    s.tokenHash = hash(token); s.paired = { instance: 'local-manager', mode: runningBuild().mode, protocol, seen: Date.now() }; write(s); return { token };
  }
  if (action === 'check') { await check(true); return { ok: true }; }
  if (action === 'cancel') { const s = read(); if (!s.job || !['queued', 'preparing'].includes(s.job.state)) throw Error('Cutover already started'); s.job.cancel = true; if (s.job.state === 'queued') s.job.state = 'cancelled'; write(s); return { ok: true }; }
  if (action === 'update') {
    const s = read(), build = runningBuild();
    if (!s.paired || Date.now() - s.paired.seen > 30_000 || s.job && !terminal(s.job.state) || s.job?.state === 'recovery-required' || !s.target || !s.checkedAt || Date.now() - s.checkedAt > 86400_000 || !eligible(build, s.target)) throw Error('No verified upgrade available');
    s.job = { id: randomBytes(16).toString('hex'), target: s.target, state: 'queued', createdAt: Date.now() }; write(s); return { ok: true };
  }
  throw Error('Unsupported local manager action');
}
