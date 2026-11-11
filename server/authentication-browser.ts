import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
class AdapterError extends Error { code: string; status: number; constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; } }
const children = new Set<import('node:child_process').ChildProcess>();
process.once('exit', () => { for (const child of children) child.kill('SIGTERM'); });

export async function findBrowser(configured?: string, family?: string) {
  const candidates = configured ? [configured] : [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  if (!configured && family === 'chrome') candidates.sort((a, b) => Number(/edge/i.test(a)) - Number(/edge/i.test(b)));
  for (const file of candidates) {
    if (await fs.access(file, fs.constants.X_OK).then(() => true, () => false)) return file;
  }
  throw new AdapterError('browser_missing', 'Install Chrome or Edge, or set browserPath to its executable.', 503);
}

// Chrome's private pipe avoids an unauthenticated remote-debugging TCP listener.
export class CDP {
  pending = new Map<number, any>(); listeners = new Set<(event: any) => void>();
  nextId = 0; buffer: Buffer = Buffer.alloc(0); closed = false;
  child: any; exit: Promise<unknown>; private closing?: Promise<void>;
  constructor(executable: string, profile: string, { headless = false, extraArgs = [] as string[], spawnProcess = spawn } = {}) {
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    const args = [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run',
      '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-background-networking', '--disable-component-update',
      ...(headless ? ['--headless=new'] : []), ...extraArgs, 'about:blank',
    ];
    this.child = spawnProcess === spawn
      ? spawn(process.execPath, [fileURLToPath(new URL('./authentication-browser-host.js', import.meta.url)), executable, ...args], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc'] })
      : spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    children.add(this.child);
    this.child.once('exit', () => children.delete(this.child));
    this.child.once('error', () => children.delete(this.child));
    this.exit = new Promise(resolve => { this.child.once('exit', resolve); this.child.once('error', resolve); });
    this.child.on('error', () => this.fail('Could not launch browser executable.'));
    this.child.on('exit', () => this.fail('Browser closed. Reopen it with the login operation.'));
    this.child.stdio[3].on('error', () => this.fail('Browser control pipe closed.'));
    this.child.stdio[4].on('error', () => this.fail('Browser control pipe closed.'));
    this.child.stdio[4].on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end;
      while ((end = this.buffer.indexOf(0)) !== -1) {
        const raw = this.buffer.subarray(0, end).toString();
        this.buffer = this.buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (message.method) {
          for (const listener of this.listeners) listener(message);
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new AdapterError('browser_error', 'Authentication browser command failed.', 502));
        else waiter.resolve(message.result);
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.fail('Browser response exceeded the limit.');
    });
  }

  fail(message: string) {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new AdapterError('browser_closed', message, 503));
    }
    this.pending.clear();
  }

  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call(method: string, params: any = {}, sessionId?: string, timeout = 20_000): Promise<any> {
    if (this.closed) return Promise.reject(new AdapterError('browser_closed', 'Browser is closed.', 503));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('browser_timeout', `${method} timed out.`, 504));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  async page(url: string, browserContextId?: string) {
    await this.call('Browser.getVersion');
    const { targetId } = await this.call('Target.createTarget', { url, ...(browserContextId ? { browserContextId } : {}) });
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    return new Page(this, sessionId, targetId);
  }

  close(): Promise<void> { return this.closing ??= this.closeProcess(); }
  private async closeProcess() {
    if (!this.closed) await this.call('Browser.close', {}, undefined, 2000).catch(() => {});
    if (this.child.exitCode === null) {
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 2000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.exit, new Promise(resolve => { deadline = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
      clearTimeout(deadline);
      if (this.child.exitCode === null) { this.child.kill('SIGKILL'); await this.exit; }
    }
    this.fail('Browser disposed.');
    this.listeners.clear();
  }
}

export class Page {
  cdp: CDP; sessionId: string; targetId: string;
  constructor(cdp: CDP, sessionId: string, targetId: string) { this.cdp = cdp; this.sessionId = sessionId; this.targetId = targetId; }
  call(method: string, params?: any, timeout?: number) { return this.cdp.call(method, params, this.sessionId, timeout); }
}
