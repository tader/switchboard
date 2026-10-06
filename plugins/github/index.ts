import type { AccountInfo, PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

async function whoami(token: string): Promise<AccountInfo> {
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'hub' },
  });
  if (res.status === 401) throw new Error('GitHub did not accept this token');
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const u = await res.json();
  return { id: String(u.id), label: u.login, avatarUrl: u.avatar_url };
}

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  const { clientId, clientSecret } = ctx.settings;
  const scopes = (c: Record<string, any>) => String(c.scopes ?? '').split(/[\s,]+/).filter(Boolean);
  const scopeField = { key: 'scopes', label: 'Scopes', default: 'repo read:user', description: 'Separated by spaces, e.g. repo, read:org, gist, workflow' };
  const shared = {
    clientId: () => clientId,
    clientSecret: () => clientSecret,
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes,
    fields: [scopeField],
    identify: (creds: { accessToken: string }) => whoami(creds.accessToken),
  };

  return {
    services: [
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories, issues and pull requests',
        icon: 'icon.svg',
        docsUrl: 'https://docs.github.com/rest',
        baseUrl: 'https://api.github.com',
        allowedHosts: ['api.github.com', 'uploads.github.com'],
        openapi: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
        authMethods: [
          apiKey.bearerToken({
            id: 'token',
            name: 'Personal access token',
            secretLabel: 'Token',
            secretDescription: 'Create one at github.com/settings/personal-access-tokens',
            identify: (creds) => whoami(creds.token),
          }),
          oauth.authorizationCode({
            ...shared,
            id: 'oauth',
            name: 'Sign in with GitHub',
            unavailable: clientId && clientSecret ? undefined : 'An administrator needs to set up a GitHub OAuth app first',
            authorizeUrl: 'https://github.com/login/oauth/authorize',
          }),
          oauth.deviceCode({
            ...shared,
            id: 'device',
            name: 'Sign in with a code',
            description: 'Enter a code at github.com/login/device',
            unavailable: clientId ? undefined : 'An administrator needs to set up a GitHub OAuth app first',
            deviceAuthorizationUrl: 'https://github.com/login/device/code',
          }),
        ],
      },
    ],
  };
}
