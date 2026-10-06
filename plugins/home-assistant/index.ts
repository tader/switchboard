import type { Connection, Field, PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

type Cfg = Record<string, any>;

const urlField: Field = {
  key: 'url',
  label: 'Home Assistant URL',
  type: 'url',
  required: true,
  placeholder: 'http://homeassistant.local:8123',
  description: 'As the hub reaches it. Browser sign-in also needs this address to work from your browser.',
};

const instance = (c: Cfg) => String(c.url ?? '').replace(/\/+$/, '');

async function identify(url: string, token: string) {
  const res = await fetch(`${url}/api/config`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`Could not reach ${url}: ${e.cause?.message ?? e.message}`);
  });
  if (res.status === 401) throw new Error('Home Assistant did not accept the token');
  if (!res.ok) throw new Error(`Home Assistant responded ${res.status}`);
  const cfg = await res.json();
  const host = new URL(url).host;
  return { id: host, label: cfg.location_name ? `${cfg.location_name} (${host})` : host };
}

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  // Home Assistant uses IndieAuth-style OAuth: the client id is the app's URL, which must share
  // its host with the redirect URI. No app registration is needed.
  const clientId = `${ctx.publicUrl}/`;

  return {
    services: [
      {
        id: 'home-assistant',
        name: 'Home Assistant',
        description: 'Smart home',
        icon: 'icon.svg',
        docsUrl: 'https://developers.home-assistant.io/docs/api/rest/',
        baseUrl: (conn: Connection) => instance(conn.config),
        authMethods: [
          oauth.authorizationCode({
            id: 'oauth',
            name: 'Sign in with Home Assistant',
            fields: [urlField],
            authorizeUrl: (c) => `${instance(c)}/auth/authorize`,
            tokenUrl: (c) => `${instance(c)}/auth/token`,
            clientId,
            pkce: false,
            identify: (creds, c) => identify(instance(c), creds.accessToken),
            async revoke(creds, c) {
              if (!creds.refreshToken) return;
              await fetch(`${instance(c)}/auth/revoke`, { method: 'POST', body: new URLSearchParams({ token: creds.refreshToken }) }).catch(() => {});
            },
          }),
          apiKey.bearerToken({
            id: 'token',
            name: 'Long-lived access token',
            secretLabel: 'Access token',
            secretDescription: 'Create one on your Home Assistant profile page, under Security',
            fields: [urlField],
            identify: (creds, c) => identify(instance(c), creds.token),
          }),
        ],
      },
    ],
  };
}
