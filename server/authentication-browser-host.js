// A separate owner survives a hard-killed Switchboard process long enough to reap
// its browser. IPC disconnect is the lifetime signal; CDP remains on private pipes.
import { spawn } from 'node:child_process';
const [executable, ...args] = process.argv.slice(2);
// Windows CRT pipe descriptors must be created by the immediate launcher.
// Relay through this owner's private stdin/stdout instead of re-inheriting fd 3/4.
const windows = process.platform === 'win32';
const browser = spawn(executable, args, { stdio: windows ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore', 3, 4] });
if (windows) {
  process.stdin.pipe(browser.stdio[3]);
  browser.stdio[4].pipe(process.stdout);
  browser.stdio[3].on('error', () => stop());
  browser.stdio[4].on('error', () => stop());
}

let stopping = false;
let deadline;
function stop() {
  if (stopping) return;
  stopping = true;
  browser.kill('SIGTERM');
  deadline = setTimeout(() => browser.kill('SIGKILL'), 2000);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
browser.on('error', () => process.exit(1));
browser.on('exit', () => { clearTimeout(deadline); process.exit(0); });
if (!process.connected) stop();
