// A separate owner survives a hard-killed Switchboard process long enough to reap
// its browser. IPC disconnect is the lifetime signal; CDP remains on private pipes.
import { spawn } from 'node:child_process';
const [executable, ...args] = process.argv.slice(2);
const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 3, 4] });
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
