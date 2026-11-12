/** Native hosts speak newline JSON on private pipes. stdout never contains logs. */
import readline from 'node:readline';
import { Controller, acquireController, type Settings } from './engine.ts';

let controller: Controller | undefined, release: (() => void) | undefined, quitting = false, busy = false, stopping = false, sequence = 0;
let latestStatus: any;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function ipc(action: string) {
  const c = controller?.child; if (!c?.connected) throw Error('Server is not connected');
  const id = ++sequence;
  return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('Server response timed out')); }, 30_000); pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } }); c.send({ kind: 'local-manager', id, action }); });
}
async function start(s: Settings) {
  if (controller) throw Error('Already started');
  attempts = 0;
  // The native host supplies validated settings over a private pipe, never argv.
  s.instance = 'local-manager'; s.mode = 'runtime';
  release = acquireController(s); controller = new Controller(s);
  controller.onMessage = message => { if (message?.kind !== 'local-manager') return; const p = pending.get(message.id); pending.delete(message.id); if (message.error) p?.reject(Error(message.error)); else p?.resolve(message.result); };
  try {
    await controller.recover();
    if (controller.journal?.phase === 'recovery-required') throw Error('Owner recovery required; inspect the updater journal');
    await controller.stop(); await controller.start(controller.current(), false);
    const until = Date.now() + 90000;
    while (true) { try { const r = await fetch(s.appUrl + "/readyz", { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {} if (Date.now() > until) throw Error("Readiness timed out"); await new Promise(r => setTimeout(r, 200)); }
    const bootstrap = await ipc('bootstrap'); emit({ event: 'started', ...bootstrap });
  } catch (e) { await controller.stop().catch(() => {}); controller = undefined; release?.(); release = undefined; throw e; }
}
async function stop() {
  if (busy) { quitting = true; emit({ event: 'finishing' }); return; }
  stopping = true;
  try { if (controller) await controller.stop(); controller = undefined; release?.(); release = undefined; } finally { stopping = false; }
  emit({ event: 'stopped' });
}
let work = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { work = work.then(async () => {
  try {
    const m = JSON.parse(line);
    if (m.action === 'start') await start(m.settings);
    else if (m.action === 'stop' || m.action === 'quit') { quitting = m.action === 'quit'; await stop(); if (quitting && !busy) process.exit(0); }
    else if (m.action === 'status' && controller) {
      if (busy) { emit({ event: 'status', ...latestStatus, eligible: false, job: controller.journal?.job && { ...controller.journal.job, state: controller.journal.phase } }); return; }
      const status = await ipc('status'); latestStatus = status;
      if (status.ready && !controller.s.token) { const paired = await ipc('pair'); controller.s.token = paired.token; emit({ event: 'paired' }); }
      emit({ event: 'status', ...status });
    } else if (['check', 'update', 'cancel'].includes(m.action)) { await ipc(m.action); emit({ event: 'accepted', action: m.action }); }
    else throw Error('Action unavailable');
  } catch { emit({ event: 'error', message: 'The action could not complete. Check the selected paths, port and recovery journal.' }); }
}); });
let attempts = 0;
const timer = setInterval(async () => {
  if (quitting || stopping || !controller?.s.token || busy) return;
  busy = true;
  try {
    const poll = await controller.api('poll', {});
    if (poll.job && !['succeeded', 'rolled-back', 'failed', 'cancelled', 'recovery-required'].includes(poll.job.state) && poll.job.id !== controller.journal?.job.id) await controller.execute(poll.job);
  } catch {
    if (!controller.childAlive() && controller.journal?.phase !== 'recovery-required') {
      if (attempts++ >= 3) { emit({ event: 'server-failed', message: 'The server stopped repeatedly. Inspect logs before starting it again.' }); quitting = true; return; }
      try { await controller.stop(); await controller.start(controller.current(), true); await controller.ready(); await controller.api('open', {}); } catch { emit({ event: 'error', message: 'Server restart failed. Stop and inspect the updater journal.' }); }
    }
  } finally { busy = false; if (quitting) { await stop(); process.exit(0); } }
}, 2000);
async function exit() { quitting = true; if (busy) return; clearInterval(timer); await work; await stop(); process.exit(0); }
lines.once('close', () => { void exit(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void exit(); });
