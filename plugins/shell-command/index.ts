import http from 'node:http';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import type { ConnectArgs, Connection, OutgoingRequest, PluginContext } from '../../server/plugins/api.ts';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;

export default async function setup(ctx: PluginContext) {
  // A central instance must never turn this into remote command execution on itself.
  if (!ctx.satellite) return {};

  const pending = new Map<string, { command: string; expires: number }>();
  const server = http.createServer((request, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const run = pending.get(token);
    pending.delete(token);
    if (!run || run.expires < Date.now()) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Invalid or expired command invocation');
      return;
    }
    exec(run.command, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
      },
    }, (error, stdout, stderr) => {
      const status = error ? 500 : 200;
      const body = error ? `${stdout}${stderr}` || error.message : stdout;
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'x-shell-exit-code': String(error?.code ?? 0),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the local command runner');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    services: [{
      id: 'shell-command',
      name: 'Shell command',
      description: 'Run a fixed command on this satellite and return its standard output',
      icon: 'icon.svg',
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      authMethods: [{
        id: 'command',
        name: 'Command',
        description: 'The same command runs on every call. Request input is not inserted into it.',
        unavailable: ctx.settings.enabled ? undefined : 'A satellite administrator must enable shell commands in the plugin settings',
        fields: [{
          key: 'command',
          label: 'Shell command',
          type: 'text',
          required: true,
          placeholder: 'printf "hello\\n"',
          description: 'Runs with /bin/sh, a 30 second timeout, 1 MB output limit, and a restricted environment',
        }],
        connect({ config }: ConnectArgs) {
          return { credentials: { command: config.command }, config: {}, account: { label: 'Shell command' } };
        },
        authorize(req: OutgoingRequest, connection: Connection) {
          const token = crypto.randomBytes(32).toString('base64url');
          pending.set(token, { command: String(connection.credentials.command), expires: Date.now() + 10_000 });
          req.headers.set('authorization', `Bearer ${token}`);
        },
      }],
    }],
    dispose: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
