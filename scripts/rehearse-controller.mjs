// Runs inside the disposable updater container. No production endpoint or provider access.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Controller, readJson, atomic, acquireController } from '/app/updater/engine.ts';
const settings = readJson('/state/settings.json');
const unlock = acquireController(settings);
class Rehearsal extends Controller {
  fail = false;
  async prepare(t) { await this.verifyImage(process.env.CANDIDATE_IMAGE,t); return process.env.CANDIDATE_IMAGE; }
  async ready(revision) { const result = await super.ready(revision); if (revision && this.fail) throw Error('Synthetic pre-open readiness failure'); return result; }
}
const c = new Rehearsal(settings);
const previous = await c.identifyCurrent();
const base = await c.api('poll',{});
const candidate = {version:base.build.version,revision:process.env.CANDIDATE_REVISION,baseRevision:base.build.revision,protocol:1,channel:'stable',notes:'Synthetic rehearsal',url:'https://example.com/release'};
async function job(id,target) {
  // Owner-only fixture injection; the browser never supplies commands, paths or targets.
  const script = `const fs=require('fs');const p='/data/update-control.json';const s=JSON.parse(fs.readFileSync(p));s.job=JSON.parse(process.argv[1]);fs.writeFileSync(p,JSON.stringify(s),{mode:384});`;
  const {command}=await import('/app/updater/engine.ts');
  const value={id,target,state:'queued',createdAt:Date.now()};
  await command('docker',['run','--rm','--network=none','--entrypoint','node','--mount',`type=volume,src=${settings.compose.dataVolume},dst=/data`,previous,'-e',script,JSON.stringify(value)]);
  return value;
}
try {
  c.fail=true; await c.execute(await job('synthetic-rollback',candidate)); assert.equal(c.journal.phase,'rolled-back'); assert.equal((await c.api('poll',{})).build.revision,base.build.revision);
  c.fail=false; await c.execute(await job('synthetic-upgrade',candidate)); assert.equal(c.journal.phase,'succeeded'); assert.equal((await c.api('poll',{})).build.revision,candidate.revision);
  assert.equal(JSON.parse(fs.readFileSync('/state/active-compose.json')).services.switchboard.environment.SWITCHBOARD_START_GATED,'0');
  console.log('PASS: real candidate rehearsal, snapshot, cutover, pre-open rollback, successful upgrade and durable ungated image pin');
} finally { unlock(); }
