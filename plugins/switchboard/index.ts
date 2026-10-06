import type { Connection, Field, PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

type Cfg = Record<string, any>;

const urlField: Field = { key: 'url', label: 'Switchboard URL', type: 'url', required: true, placeholder: 'https://switchboard.example.com' };
const remoteUrl = (c: Cfg) => String(c.url ?? '').replace(/\/+$/, '');

async function whoami(url: string, token: string) {
  const res = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`Could not reach ${url}: ${e.cause?.message ?? e.message}`);
  });
  if (res.status === 401) throw new Error('That Switchboard did not accept the token');
  if (!res.ok) throw new Error(`That Switchboard responded ${res.status}`);
  const me = await res.json();
  const host = new URL(url).host;
  return { id: `${me.id}@${host}`, label: `${me.username} @ ${host}` };
}

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');

  return {
    services: [
      {
        id: 'switchboard',
        name: 'Switchboard',
        description: 'Accounts connected to another Switchboard',
        icon: 'icon.svg',
        baseUrl: (conn: Connection) => remoteUrl(conn.config),
        openapi: (conn: Connection) => `${remoteUrl(conn.config)}/api/openapi.json`,
        authMethods: [
          oauth.authorizationCode({
            id: 'oauth',
            name: 'Sign in with Switchboard',
            description: 'Approve access on the other Switchboard',
            fields: [urlField],
            authorizeUrl: (c) => `${remoteUrl(c)}/oauth/authorize`,
            tokenUrl: (c) => `${remoteUrl(c)}/oauth/token`,
            // No registration needed: the other Switchboard identifies this one by its URL.
            clientId: `${ctx.publicUrl}/`,
            identify: (creds, c) => whoami(remoteUrl(c), creds.accessToken),
            async revoke(creds, c) {
              await fetch(`${remoteUrl(c)}/api/me/token`, { method: 'DELETE', headers: { authorization: `Bearer ${creds.accessToken}` } }).catch(() => {});
            },
          }),
          apiKey.bearerToken({
            id: 'token',
            name: 'API token',
            secretDescription: 'Create one on the other Switchboard’s API tokens page',
            fields: [urlField],
            identify: (creds, c) => whoami(remoteUrl(c), creds.token),
          }),
        ],
      },
    ],
  };
}
