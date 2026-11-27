import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { all, db, one, run } from './db.ts';
import { encrypt, decrypt } from './crypto.ts';
import { badRequest, notFound, HttpError } from './http.ts';
import type { OutputPreviewRule } from './plugins/api.ts';
import { openPreviewStore, syncDirectory, previewGeneration, removePreviewFile, previewFilePattern, assertOwnedPreviewStore, readPreviewFile, writePreviewFile, listPreviewFiles, previewFileExists } from '../shared/activity-preview-store.ts';

export const OUTPUT_LIMIT = 16 * 1024;
let store: { root: string; generation: string; excluded: string[]; instance: string; storeId: string } | undefined;
const policyKey = 'activity-output-retention';
export function outputPolicy(): { hours: number; revision: number } {
  return JSON.parse(one('SELECT value FROM instance_settings WHERE key = ?', policyKey)?.value ?? '{"hours":4,"revision":0}');
}
function transaction<T>(f: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function initOutputStore() {
  store = undefined;
  if (!config.previewRoot || !config.previewRestoreSafe || !config.previewInstance || !config.previewEpoch || !config.previewStoreId) return;
  try {
    const excluded = [config.dataDir, config.root, ...JSON.parse(config.previewExcludedRoots ?? '[]')];
    if (assertOwnedPreviewStore(config.previewRoot, excluded, config.previewInstance).storeId !== config.previewStoreId) throw Error('Preview store binding changed');
    openPreviewStore(config.previewRoot, excluded, config.previewInstance);
    const state = previewGeneration(config.previewRoot, excluded, config.previewInstance);
    const generation = fencedGeneration(state.generation);
    store = { root: config.previewRoot, generation, excluded, instance: config.previewInstance, storeId: state.identity.storeId };
    sweepOutputs();
  } catch { store = undefined; console.warn('Activity output capture omitted: isolated preview storage unavailable'); }
}
function fencedGeneration(generation: string) {
  return createHash('sha256').update(generation + ':' + config.previewEpoch).digest('hex');
}
function file(capture: string) {
  if (!store || !/^[a-f0-9-]{36}$/.test(capture)) throw Error('Preview storage unavailable');
  const state = previewGeneration(store.root, store.excluded, store.instance);
  if (state.retiring || fencedGeneration(state.generation) !== store.generation || state.identity.storeId !== store.storeId) throw Error('Preview generation retired');
  return path.join(store.root, 'preview-' + store.storeId + '-' + capture + '.enc');
}
/** The startup and minute-timer path share recovery: no process restart is needed. */
export function maintainOutputs() {
  if (!store) { initOutputStore(); if (!store) sweepOutputs(); return; }
  try { sweepOutputs(); } catch { store = undefined; }
}
export function sweepOutputs(time = Date.now()) {
  transaction(() => {
    run("UPDATE audit_log SET output_state = 'expired' WHERE id IN (SELECT audit_id FROM audit_outputs WHERE expires_at <= ?)", time);
    run('DELETE FROM audit_outputs WHERE expires_at <= ?', time);
    if (store) {
      run("UPDATE audit_log SET output_state = 'unavailable' WHERE id IN (SELECT audit_id FROM audit_outputs WHERE generation != ?)", store.generation);
      run('DELETE FROM audit_outputs WHERE generation != ?', store.generation);
    }
  });
  if (!store) return;
  for (const row of all('SELECT capture_id FROM audit_output_unlinks')) {
    removePreviewFile(store.root, path.basename(file(row.capture_id)), store.excluded, store.instance);
    run('DELETE FROM audit_output_unlinks WHERE capture_id = ?', row.capture_id);
  }
  for (const name of listPreviewFiles(store.root, store.excluded, store.instance)) {
    const match = name.match(previewFilePattern);
    if (!match || match[1] !== store.storeId) continue; // Unknown sentinels/directories are never ours to delete.
    const capture = match[2];
    if (name.endsWith('.tmp') || !one('SELECT 1 FROM audit_outputs WHERE capture_id = ? AND generation = ?', capture, store.generation)) {
      removePreviewFile(store.root, name, store.excluded, store.instance);
    }
  }
  // Missing files also revoke metadata (including files removed outside the app).
  for (const r of all('SELECT audit_id, capture_id FROM audit_outputs')) if (!previewFileExists(store.root, path.basename(file(r.capture_id)), store.excluded, store.instance)) {
    run("UPDATE audit_log SET output_state = 'unavailable' WHERE id = ?", r.audit_id);
    run('DELETE FROM audit_outputs WHERE audit_id = ?', r.audit_id);
  }
  syncDirectory(store.root);
}
export function outputCaptureAvailability(): { available: boolean; reason: 'ready' | 'restore-unsupported' | 'not-provisioned' | 'storage-unavailable' } {
  if (!config.previewRestoreSafe || !config.previewInstance || !config.previewEpoch || !config.previewStoreId) return { available: false, reason: 'restore-unsupported' };
  if (!config.previewRoot) return { available: false, reason: 'not-provisioned' };
  if (!store) return { available: false, reason: 'storage-unavailable' };
  try {
    file('00000000-0000-0000-0000-000000000000');
    fs.accessSync(store.root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return { available: true, reason: 'ready' };
  } catch { return { available: false, reason: 'storage-unavailable' }; }
}
function retentionRevision(policy: ReturnType<typeof outputPolicy>) {
  // Include value and the external restore epoch: a restored numeric revision is not a fresh approval.
  return createHash('sha256').update(JSON.stringify({ ...policy, epoch: config.previewEpoch })).digest('hex');
}
export function outputRetentionSettings() {
  const policy = outputPolicy();
  return { hours: policy.hours, revision: retentionRevision(policy), capture: outputCaptureAvailability() };
}
export function setOutputRetention(hours: unknown, expectedRevision?: string) {
  if (typeof hours !== 'number' || !Number.isSafeInteger(hours) || hours < 0 || hours > Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 3600_000)) throw badRequest('Enter a whole number of hours, 0 or greater.');
  transaction(() => {
    const old = outputPolicy();
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw badRequest('Load the current retention policy revision before saving.');
    if (expectedRevision !== undefined && retentionRevision(old) !== expectedRevision) {
      throw Object.assign(new HttpError(409, 'Output preview retention changed. Reload the setting and review your change.'), { code: 'retention_conflict' });
    }
    run('INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', policyKey, JSON.stringify({ hours, revision: old.revision + 1 }));
    if (!hours) {
      run("UPDATE audit_log SET output_state = 'expired' WHERE id IN (SELECT audit_id FROM audit_outputs)");
      run('DELETE FROM audit_outputs');
    } else if (hours < old.hours) run('UPDATE audit_outputs SET expires_at = min(expires_at, captured_at + ?)', hours * 3600_000);
  });
  // A successful disable includes physical removal; failures remain retryable.
  sweepOutputs();
  if (!hours && one('SELECT 1 FROM audit_output_unlinks')) throw new HttpError(503, 'Preview storage is unavailable; deletion will be retried.');
  return outputPolicy();
}
export function outputMetadata(userId: string, id: number, time = Date.now()) {
  const parent = one('SELECT output_state, peer_id, source FROM audit_log WHERE id = ? AND user_id = ?', id, userId);
  if (!parent) throw notFound('Entry not found');
  const r = one('SELECT * FROM audit_outputs WHERE audit_id = ?', id);
  if (parent.peer_id || parent.source === 'plugin') return { state: 'omitted' };
  if (!r) return { state: parent.output_state === 'captured' ? 'unavailable' : parent.output_state };
  if (parent.output_state !== 'captured') return { state: parent.output_state };
  if (time >= r.expires_at || !outputPolicy().hours) return { state: 'expired' };
  if (!store || r.generation !== store.generation) return { state: 'unavailable' };
  return { state: 'retained', captureId: r.capture_id, expiresAt: r.expires_at };
}
export function readOutput(userId: string, id: number, payload: boolean, time = Date.now()): Record<string, unknown> {
  const meta = outputMetadata(userId, id, time);
  if (meta.state !== 'retained') return { ...meta, decisionAt: time };
  const r = one('SELECT * FROM audit_outputs WHERE audit_id = ?', id)!;
  try {
    // Even status checks verify the file/generation; never decrypt for status.
    const location = file(r.capture_id);
    if (!store) throw Error('Preview storage unavailable');
    const ciphertext = readPreviewFile(store.root, path.basename(location), store.excluded, store.instance, store.storeId, OUTPUT_LIMIT * 2 + 2048);
    const bound = payload ? decrypt(ciphertext) : undefined;
    const decisionAt = Math.max(time, Date.now());
    const checked = outputMetadata(userId, id, decisionAt);
    if (checked.state !== 'retained' || checked.captureId !== meta.captureId) return { ...checked, decisionAt };
    if (payload && (bound.owner !== userId || bound.auditId !== id || bound.captureId !== r.capture_id || bound.generation !== r.generation)) throw Error('Invalid preview binding');
    return { ...checked, decisionAt, displayForMs: Math.min(15_000, r.expires_at - decisionAt), ...(payload ? { preview: bound.preview } : {}) };
  } catch { return { state: 'unavailable', decisionAt: time }; }
}

/** A new object of reviewed string fields only. No unknown or nested values survive. */
export function projectOutput(body: Buffer, rule: OutputPreviewRule, secrets: string[]) {
  if (!body.length || body.length > OUTPUT_LIMIT) return;
  let parsed: any;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const preview: Record<string, string> = Object.create(null);
  for (const [field, spec] of Object.entries(rule.fields)) {
    if (/pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|cookie|session|private[-_]?key/i.test(field) || !Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > OUTPUT_LIMIT) return;
    const v = parsed[field];
    if (typeof v !== 'string' || !v || /[\s\p{C}]/u.test(v) || Buffer.byteLength(v) > Math.min(spec.maxBytes, OUTPUT_LIMIT) || secrets.some(s => s && v.includes(s))) return;
    preview[field] = v;
  }
  if (!Object.keys(preview).length || Buffer.byteLength(JSON.stringify(preview)) > OUTPUT_LIMIT) return;
  return preview;
}

export function observeOutput(response: Response, id: number, owner: string, rule: OutputPreviewRule | undefined, secrets: string[]): Response {
  if (one('SELECT 1 FROM audit_outputs WHERE audit_id = ?', id)) return response;
  const policy = outputPolicy();
  run('UPDATE audit_log SET output_state = ? WHERE id = ?', policy.hours ? 'omitted' : 'disabled', id);
  if (!rule || !store || !policy.hours || !response.body || response.status !== 200 || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return response;
  const generation = store.generation;
  const nonce = one('SELECT output_nonce FROM audit_log WHERE id = ? AND user_id = ?', id, owner)?.output_nonce;
  const captureId = randomUUID();
  let size = 0;
  let chunks: Buffer[] = [];
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      size += chunk.byteLength;
      if (size <= OUTPUT_LIMIT) chunks.push(Buffer.from(chunk)); else chunks = [];
      ctrl.enqueue(chunk);
    },
    flush() {
      // No flush on cancellation, interrupted bodies or upstream stream errors.
      if (size > OUTPUT_LIMIT) return;
      try {
        const preview = projectOutput(Buffer.concat(chunks), rule, secrets);
        if (!preview || outputPolicy().revision !== policy.revision || !one('SELECT 1 FROM audit_log WHERE id = ? AND user_id = ? AND output_nonce = ?', id, owner, nonce) || store?.generation !== generation) return;
        const capturedAt = Date.now();
        const destination = file(captureId);
        writePreviewFile(store.root, path.basename(destination), encrypt({ preview, owner, auditId: id, captureId, generation }), store.excluded, store.instance, store.storeId);
        transaction(() => {
          if (outputPolicy().revision !== policy.revision) return;
          run('INSERT INTO audit_outputs VALUES(?,?,?,?,?)', id, captureId, generation, capturedAt, capturedAt + policy.hours * 3600_000);
          run("UPDATE audit_log SET output_state = 'captured' WHERE id = ? AND user_id = ?", id, owner);
        });
      } catch { /* Preview failures must never affect response delivery. Orphans are swept. */ }
      finally { chunks = []; }
    },
  });
  return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers: response.headers });
}
