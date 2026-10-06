import type { AuthMethod, Connection, Field, PluginContext, ServiceDefinition } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';
import type * as ApiKey from '../api-key/index.ts';

type Cfg = Record<string, any>;
type Product = 'jira' | 'confluence';

const PRODUCTS = {
  jira: {
    name: 'Jira',
    description: 'Issues and projects',
    icon: 'jira.svg',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    openapi: 'https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json',
    scopes: 'read:jira-work write:jira-work read:jira-user read:me offline_access',
    // Checks credentials and names the account, on a site or on Data Center.
    me: { cloud: '/rest/api/3/myself', server: '/rest/api/2/myself' },
  },
  confluence: {
    name: 'Confluence',
    description: 'Pages and spaces',
    icon: 'confluence.svg',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/',
    openapi: 'https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json',
    scopes:
      'read:page:confluence write:page:confluence read:space:confluence read:attachment:confluence read:comment:confluence write:comment:confluence search:confluence read:confluence-content.all read:me offline_access',
    me: { cloud: '/wiki/rest/api/user/current', server: '/rest/api/user/current' },
  },
} as const;

/** Accepts "yourteam", "yourteam.atlassian.net" and full URLs. */
function siteUrl(input: unknown): string {
  let s = String(input ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s.includes('.') ? s : `${s}.atlassian.net`}`;
  return s;
}

async function getJson(url: string, auth: string, what: string) {
  const res = await fetch(url, { headers: { authorization: auth, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch((e) => {
    throw new Error(`Could not reach ${new URL(url).host}: ${e.cause?.message ?? e.message}`);
  });
  if (res.status === 401 || res.status === 403) throw new Error(`${what} did not accept these credentials`);
  if (res.status === 404) throw new Error(`No ${what} found at ${new URL(url).origin}`);
  if (!res.ok) throw new Error(`${what} responded ${res.status}`);
  return res.json();
}

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  const configured = !!(ctx.settings.clientId && ctx.settings.clientSecret);

  function service(product: Product): ServiceDefinition {
    const p = PRODUCTS[product];
    const siteField = (required: boolean, dc = false): Field => ({
      key: 'site',
      label: dc ? 'Server URL' : 'Site',
      required,
      placeholder: dc ? `https://${product}.example.com` : 'yourteam.atlassian.net',
      description: dc ? undefined : required ? undefined : 'When your account can access several sites. Defaults to the first one.',
    });

    // OAuth 2.0 (3LO). API calls go through api.atlassian.com/ex/<product>/<cloudId>, so after
    // sign-in we look up which site (cloud id) was authorized.
    const base = oauth.authorizationCode({
      id: 'oauth',
      name: 'Sign in with Atlassian',
      description: 'Atlassian cloud',
      unavailable: configured ? undefined : 'An administrator needs to set up an Atlassian OAuth app first',
      fields: [siteField(false), { key: 'scopes', label: 'Scopes', type: 'textarea', advanced: true, default: p.scopes }],
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      clientId: () => ctx.settings.clientId,
      clientSecret: () => ctx.settings.clientSecret,
      scopes: (c) => String(c.scopes || p.scopes).split(/\s+/).filter(Boolean),
      authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
      pkce: false,
    });
    const signIn: AuthMethod = {
      ...base,
      async callback(args) {
        const result = await base.callback!(args);
        const token = `Bearer ${result.credentials.accessToken}`;
        const resources: any[] = await getJson('https://api.atlassian.com/oauth/token/accessible-resources', token, 'Atlassian');
        const wanted = siteUrl(args.config.site);
        const site = wanted ? resources.find((r) => r.url.replace(/\/+$/, '') === wanted) : resources[0];
        if (!site) throw new Error(wanted ? `You did not grant access to ${wanted}` : 'You did not grant access to any site');
        let me: any = {};
        try {
          me = await getJson('https://api.atlassian.com/me', token, 'Atlassian');
        } catch {}
        const siteName = new URL(site.url).host.replace(/\.atlassian\.net$/, '');
        return {
          credentials: result.credentials,
          config: { ...args.config, cloudId: site.id, site: site.url },
          account: { id: `${me.account_id ?? 'user'}@${site.id}`, label: `${me.email ?? me.name ?? 'Atlassian account'} (${siteName})`, avatarUrl: me.picture },
        };
      },
    };

    const identifyAt = (kind: 'cloud' | 'server') => async (auth: string, c: Cfg) => {
      const site = siteUrl(c.site);
      const u = await getJson(site + p.me[kind], auth, p.name);
      const who = u.emailAddress ?? u.email ?? u.displayName ?? u.name ?? u.username ?? 'Account';
      return { id: `${u.accountId ?? u.key ?? u.name ?? who}@${new URL(site).host}`, label: `${who} (${new URL(site).host})`, avatarUrl: u.avatarUrls?.['48x48'] };
    };

    return {
      id: product,
      name: p.name,
      description: p.description,
      icon: p.icon,
      docsUrl: p.docsUrl,
      baseUrl: (conn: Connection) => (conn.methodId === 'oauth' ? `https://api.atlassian.com/ex/${product}/${conn.config.cloudId}` : siteUrl(conn.config.site)),
      allowedHosts: (conn: Connection) => (conn.methodId === 'oauth' ? ['api.atlassian.com'] : [new URL(siteUrl(conn.config.site)).host]),
      // The cloud API description does not fit Data Center.
      openapi: (conn: Connection) => (conn.methodId === 'pat' ? undefined : p.openapi),
      authMethods: [
        signIn,
        apiKey.basicAuth({
          id: 'api-token',
          name: 'API token',
          description: 'Atlassian cloud, with your email address',
          usernameLabel: 'Email',
          secretLabel: 'API token',
          secretDescription: 'Create one at id.atlassian.com/manage-profile/security/api-tokens',
          fields: [siteField(true)],
          identify: (creds, c) => identifyAt('cloud')(`Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`, c),
        }),
        apiKey.bearerToken({
          id: 'pat',
          name: 'Personal access token',
          description: 'Data Center and Server',
          secretDescription: 'Create one in your profile, under Personal access tokens',
          fields: [siteField(true, true)],
          identify: (creds, c) => identifyAt('server')(`Bearer ${creds.token}`, c),
        }),
      ],
    };
  }

  return { services: [service('jira'), service('confluence')] };
}
