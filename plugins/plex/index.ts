import fs from 'node:fs';
import path from 'node:path';
import type { AuthMethod, Connected, Connection, Field, OutgoingRequest, PluginContext } from '../../server/plugins/api.ts';

const PLEX = 'https://plex.tv';

interface PlexCredentials {
  /** Account token, for plex.tv. */
  token: string;
  /** Token for the chosen server; differs from the account token on servers shared with you. */
  serverToken?: string;
}

const serverField: Field = {
  key: 'serverUrl',
  label: 'Server URL',
  type: 'url',
  advanced: true,
  placeholder: 'https://192-168-1-10.abc123.plex.direct:32400',
  description: 'Found automatically when empty: the first server the hub can reach.',
};

export default function setup(ctx: PluginContext) {
  // Plex identifies apps by a stable client identifier; pins must be polled with the same one.
  const idFile = path.join(ctx.dataDir, 'client-id');
  if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, crypto.randomUUID());
  const clientId = fs.readFileSync(idFile, 'utf8').trim();
  const plexHeaders = (token?: string): Record<string, string> => ({
    accept: 'application/json',
    'x-plex-product': 'Hub',
    'x-plex-client-identifier': clientId,
    ...(token ? { 'x-plex-token': token } : {}),
  });

  async function plex(p: string, init: RequestInit & { token?: string } = {}) {
    const res = await fetch(PLEX + p, { ...init, headers: { ...plexHeaders(init.token), ...(init.headers as any) }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) throw new Error('Plex did not accept this token');
    if (!res.ok) throw new Error(`Plex responded ${res.status}`);
    return res.json();
  }

  /** Picks a server and the first of its addresses that answers, preferring local HTTPS. */
  async function findServer(token: string, wanted?: string): Promise<{ url?: string; name?: string; serverToken?: string }> {
    const resources: any[] = await plex('/api/v2/resources?includeHttps=1&includeRelay=1', { token }).catch(() => []);
    const servers = resources.filter((r) => String(r.provides).split(',').includes('server'));
    if (wanted) {
      const host = new URL(wanted).host;
      const s = servers.find((r) => r.connections?.some((c: any) => new URL(c.uri).host === host));
      return { url: wanted.replace(/\/+$/, ''), name: s?.name, serverToken: s?.accessToken };
    }
    servers.sort((a, b) => Number(b.owned) - Number(a.owned));
    for (const s of servers) {
      const rank = (c: any) => (c.relay ? 4 : 0) + (c.protocol === 'https' ? 0 : 2) + (c.local ? 0 : 1);
      for (const c of [...(s.connections ?? [])].sort((a, b) => rank(a) - rank(b))) {
        try {
          const res = await fetch(`${c.uri}/identity`, { headers: plexHeaders(s.accessToken ?? token), signal: AbortSignal.timeout(3000) });
          if (res.ok) return { url: c.uri, name: s.name, serverToken: s.accessToken ?? token };
        } catch {}
      }
    }
    return {};
  }

  async function finish(token: string, config: Record<string, any>): Promise<Connected> {
    const u = await plex('/api/v2/user', { token });
    const server = await findServer(token, config.serverUrl);
    const credentials: PlexCredentials = { token, serverToken: server.serverToken };
    return {
      credentials,
      config: { ...config, serverUrl: server.url, serverName: server.name },
      account: { id: u.uuid, label: server.name ? `${u.username ?? u.email} · ${server.name}` : u.username ?? u.email, avatarUrl: u.thumb },
    };
  }

  async function checkPin(id: number): Promise<string | undefined> {
    const pin = await plex(`/api/v2/pins/${id}`);
    return pin.authToken || undefined;
  }

  const shared = {
    authorize(req: OutgoingRequest, conn: Connection) {
      const creds = conn.credentials as PlexCredentials;
      const onServer = conn.config.serverUrl && req.url.host === new URL(conn.config.serverUrl).host;
      for (const [k, v] of Object.entries(plexHeaders(onServer ? creds.serverToken ?? creds.token : creds.token))) {
        // Plex answers with XML unless asked for JSON; respect an explicit Accept header.
        if (k !== 'accept' || !req.headers.has('accept')) req.headers.set(k, v);
      }
    },
    async token(conn: Connection) {
      return { accessToken: (conn.credentials as PlexCredentials).token, tokenType: 'X-Plex-Token' };
    },
  };

  const signIn: AuthMethod = {
    id: 'plex',
    name: 'Sign in with Plex',
    fields: [serverField],
    async connect({ callbackUrl, state }) {
      const pin = await plex('/api/v2/pins?strong=true', { method: 'POST' });
      const q = new URLSearchParams({
        clientID: clientId,
        code: pin.code,
        forwardUrl: `${callbackUrl}?state=${encodeURIComponent(state)}`,
        'context[device][product]': 'Hub',
      });
      return { redirect: `https://app.plex.tv/auth#?${q}`, pending: { pinId: pin.id } };
    },
    async callback({ pending, config }) {
      // Plex sends the browser back as soon as the user approves; the token may take a moment.
      for (let i = 0; i < 6; i++) {
        const token = await checkPin(pending.pinId);
        if (token) return finish(token, config);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('Signing in to Plex was not completed');
    },
    ...shared,
  };

  const code: AuthMethod = {
    id: 'link',
    name: 'Sign in with a code',
    description: 'Enter a code at plex.tv/link',
    fields: [serverField],
    async connect() {
      const pin = await plex('/api/v2/pins', { method: 'POST' });
      return {
        device: { userCode: pin.code, verificationUri: 'https://plex.tv/link', expiresIn: pin.expiresIn ?? 900, interval: 2 },
        pending: { pinId: pin.id },
      };
    },
    async poll({ pending, config }) {
      const token = await checkPin(pending.pinId);
      return token ? finish(token, config) : { wait: true };
    },
    ...shared,
  };

  const token: AuthMethod = {
    id: 'token',
    name: 'Plex token',
    fields: [
      {
        key: 'token',
        label: 'Token',
        type: 'secret',
        required: true,
        description: 'The X-Plex-Token of your account (see support.plex.tv, "Finding an authentication token")',
      },
      serverField,
    ],
    async connect({ config }) {
      const { token: t, ...rest } = config;
      return finish(t, rest);
    },
    ...shared,
  };

  return {
    services: [
      {
        id: 'plex',
        name: 'Plex',
        description: 'Media servers and your Plex account',
        icon: 'icon.svg',
        docsUrl: 'https://plexapi.dev',
        baseUrl: (conn: Connection) => conn.config.serverUrl || PLEX,
        allowedHosts: (conn: Connection) => [
          'plex.tv',
          '*.plex.tv',
          '*.plex.direct',
          ...(conn.config.serverUrl ? [new URL(conn.config.serverUrl).host] : []),
        ],
        // Community-maintained description of the Plex Media Server API.
        openapi: (conn: Connection) => (conn.config.serverUrl ? 'https://raw.githubusercontent.com/LukeHagar/plex-api-spec/main/plex-api-spec.yaml' : undefined),
        authMethods: [signIn, code, token],
      },
    ],
  };
}
