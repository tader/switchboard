import type { PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

const API = 'https://api.todoist.com';
const DOCS = 'https://developer.todoist.com/api/v1/';

async function whoami(token: string) {
  const res = await fetch(`${API}/api/v1/user`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new Error('Todoist did not accept this token');
  if (!res.ok) throw new Error(`Todoist responded ${res.status}`);
  const u = await res.json();
  return { id: String(u.id), label: u.email ?? u.full_name, avatarUrl: u.avatar_big ?? u.avatar_medium ?? undefined };
}

// Todoist does not publish its OpenAPI document as a file; it is embedded in the API reference page.
let spec: { at: number; doc: object } | undefined;
async function openapi(): Promise<object | undefined> {
  if (spec && Date.now() - spec.at < 24 * 3600_000) return spec.doc;
  const html = await (await fetch(DOCS, { signal: AbortSignal.timeout(60_000) })).text();
  const m = html.match(/__redoc_state\s*=\s*/);
  if (!m) throw new Error('The Todoist API reference changed; no API description found');
  const start = m.index! + m[0].length;
  // The state is a JSON object literal followed by ";"; find its end by tracking braces outside strings.
  let depth = 0;
  let inString = false;
  let end = start;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const doc = JSON.parse(html.slice(start, end)).spec.data;
  spec = { at: Date.now(), doc };
  return doc;
}

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  const configured = !!(ctx.settings.clientId && ctx.settings.clientSecret);

  return {
    services: [
      {
        id: 'todoist',
        name: 'Todoist',
        description: 'Tasks and projects',
        icon: 'icon.svg',
        docsUrl: DOCS,
        baseUrl: API,
        allowedHosts: ['api.todoist.com'],
        openapi,
        authMethods: [
          apiKey.bearerToken({
            id: 'token',
            name: 'API token',
            secretDescription: 'Find it in Todoist under Settings → Integrations → Developer',
            identify: (creds) => whoami(creds.token),
          }),
          oauth.authorizationCode({
            id: 'oauth',
            name: 'Sign in with Todoist',
            unavailable: configured ? undefined : 'An administrator needs to set up a Todoist app first',
            fields: [
              {
                key: 'access',
                label: 'Access',
                type: 'select',
                default: 'data:read_write,data:delete',
                options: [
                  { value: 'data:read', label: 'Read tasks and projects' },
                  { value: 'data:read_write', label: 'Read and edit' },
                  { value: 'data:read_write,data:delete', label: 'Read, edit and delete' },
                ],
              },
            ],
            authorizeUrl: 'https://todoist.com/oauth/authorize',
            tokenUrl: 'https://todoist.com/oauth/access_token',
            clientId: () => ctx.settings.clientId,
            clientSecret: () => ctx.settings.clientSecret,
            scopes: (c) => String(c.access || 'data:read_write').split(','),
            scopeSeparator: ',',
            pkce: false,
            identify: (creds) => whoami(creds.accessToken),
            async revoke(creds) {
              const q = new URLSearchParams({ client_id: ctx.settings.clientId, client_secret: ctx.settings.clientSecret, access_token: creds.accessToken });
              await fetch(`${API}/api/v1/access_tokens?${q}`, { method: 'DELETE' }).catch(() => {});
            },
          }),
        ],
      },
    ],
  };
}
