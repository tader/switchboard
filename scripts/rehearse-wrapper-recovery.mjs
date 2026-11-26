// Disposable fixture only: stage a candidate without running its extension initialization.
import { Controller, acquireController, readJson, command } from '/app/updater/engine.ts';
const settings = readJson('/state/settings.json'), unlock = acquireController(settings);
try {
  const c = new Controller(settings);
  const image = await c.identifyCurrent(), poll = await c.api('poll', {});
  const mode = process.argv[2];
  const job = { id: 'wrapper-' + mode, state: 'starting', createdAt: Date.now(), target: {
    version: poll.build.version, revision: 'b'.repeat(40), baseRevision: 'a'.repeat(40), protocol: 1, channel: 'stable', notes: 'Synthetic wrapper recovery', url: 'https://example.test/release',
  } };
  await c.api('drain', {}); await c.stop();
  const inject = "const fs=require('fs');const p='/data/update-control.json',s=JSON.parse(fs.readFileSync(p));s.job=JSON.parse(process.argv[1]);fs.writeFileSync(p,JSON.stringify(s),{mode:384});";
  await command('docker', ['run', '--rm', '--network=none', '--entrypoint', 'node', '--mount', 'type=volume,src='+settings.compose.dataVolume+',dst=/data', image, '-e', inject, JSON.stringify(job)]);
  c.journal = { job, previous: image, target: image, phase: 'snapshot', startedAt: Date.now(), durations: {} };
  await c.snapshot();
  const probe = "const fs=require('fs');fs.mkdirSync('/data/plugins/wrapper-open-probe',{recursive:true});fs.writeFileSync('/data/plugins/wrapper-open-probe/plugin.json',JSON.stringify({id:'wrapper-open-probe',name:'Synthetic open probe',version:'1.0.0'}));fs.writeFileSync('/data/plugins/wrapper-open-probe/index.ts',\"import fs from 'node:fs';export default()=>{fs.writeFileSync('/data/candidate-opened','opened');return{}}\");";
  await command('docker', ['run', '--rm', '--network=none', '--entrypoint', 'node', '--mount', 'type=volume,src='+settings.compose.dataVolume+',dst=/data', image, '-e', probe]);
  c.journal.phase = mode === 'required' ? 'recovery-required' : 'starting';
  c.journal.opened = mode === 'required'; c.save();
  await c.start(image, true); await c.ready();
  // A saved ungated override must never bypass the journal when the wrapper is run.
  c.override(image, false);
  console.log('Staged synthetic ' + mode + ' journal without opening candidate plugins.');
} finally { unlock(); }
