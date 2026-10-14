import type { PluginContext, Connection } from '../../../server/plugins/api.ts';
import type * as ApiKey from '../../../plugins/api-key/index.ts';
import type * as OAuth from '../../../plugins/oauth2/index.ts';
export default function setup(ctx: PluginContext) {
  const apiKey = ctx.require<typeof ApiKey>('api-key');
  const oauth = ctx.require<typeof OAuth>('oauth2');
  const fields = [{ key: 'baseUrl', label: 'Base URL', type: 'url' as const, required: true }, { key: 'clientSecret', label: 'Client secret', type: 'secret' as const }, { key: 'clientId', label: 'Client ID' }];
  const identify = async (credentials: any, config: any, product: string) => {
    const response = await fetch(`${config.baseUrl}/${product}/me`, { headers: { authorization: `Bearer ${credentials.token ?? credentials.accessToken}` }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Invalid provider credentials');
    return await response.json();
  };
  return { services: ['a','b'].map(product => ({
    id: `reuse-${product}`, name: product, baseUrl: (conn: Connection) => conn.config.baseUrl,
    authMethods: [
      apiKey.bearerToken({ fields, identify: (credentials, config) => identify(credentials, config, product) }),
      apiKey.headerKey({ id: 'header', header: 'x-api-key', fields, identify: (credentials, config) => identify({ token: credentials.key }, config, product) }),
      oauth.authorizationCode({
        id: 'oauth', fields, clientId: config => config.clientId || 'fake-client', clientSecret: config => config.clientSecret || 'fake-secret', tokenUrl: config => `${config.baseUrl}/oauth/token`, authorizeUrl: config => `${config.baseUrl}/oauth/authorize`, pkce: false,
        scopes: [product],
        identify: (credentials, config) => identify(credentials, config, product),
        reusable: { configKeys: ['clientId', 'clientSecret'], allowRequest: req => req.url.pathname.startsWith(`/${product}/`) && req.method === 'GET' },
      }),
    ],
  })) };
}
