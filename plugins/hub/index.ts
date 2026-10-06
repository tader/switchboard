import type { Connection, Field, PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

type Cfg = Record<string, any>;

const urlField: Field = { key: 'url', label: 'Hub URL', type: 'url', required: true, placeholder: 'https://hub.example.com' };
const hubUrl = (c: Cfg) => String(c.url ?? '').replace(/\/+$/, '');

async function whoami(url: string, token: string) {
  const res = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`Could not reach ${url}: ${e.cause?.message ?? e.message}`);
  });
  if (res.status === 401) throw new Error('That hub did not accept the token');
  if (!res.ok) throw new Error(`That hub responded ${res.status}`);
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
        id: 'hub',
        name: 'Hub',
        description: 'Accounts connected to another hub',
        icon: 'icon.svg',
        baseUrl: (conn: Connection) => hubUrl(conn.config),
        openapi: (conn: Connection) => `${hubUrl(conn.config)}/api/openapi.json`,
        authMethods: [
          oauth.authorizationCode({
            id: 'oauth',
            name: 'Sign in with Hub',
            description: 'Approve access on the other hub',
            fields: [urlField],
            authorizeUrl: (c) => `${hubUrl(c)}/oauth/authorize`,
            tokenUrl: (c) => `${hubUrl(c)}/oauth/token`,
            // No registration needed: the other hub identifies this one by its URL.
            clientId: `${ctx.publicUrl}/`,
            identify: (creds, c) => whoami(hubUrl(c), creds.accessToken),
            async revoke(creds, c) {
              await fetch(`${hubUrl(c)}/api/me/token`, { method: 'DELETE', headers: { authorization: `Bearer ${creds.accessToken}` } }).catch(() => {});
            },
          }),
          apiKey.bearerToken({
            id: 'token',
            name: 'API token',
            secretDescription: 'Create one on the other hub’s API tokens page',
            fields: [urlField],
            identify: (creds, c) => whoami(hubUrl(c), creds.token),
          }),
        ],
      },
    ],
  };
}
