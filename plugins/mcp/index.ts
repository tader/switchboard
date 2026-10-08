import type { AuthMethod, Connection, Field, PluginContext } from '../../server/plugins/api.ts';

const endpoint: Field = { key: 'endpoint', label: 'MCP endpoint', type: 'url', required: true, placeholder: 'https://example.com/mcp' };

function direct(id: string, name: string, fields: Field[]): AuthMethod {
  return {
    id, name, fields: [endpoint, ...fields],
    connect({ config }) {
      const url = new URL(config.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Enter an HTTP or HTTPS endpoint without a username, password or fragment');
      if (id === 'header' && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.header) || /^(host|cookie|content-type|content-length|accept|origin|connection|mcp-.*|x-hub-.*|x-switchboard-.*)$/i.test(config.header))) {
        throw new Error('Choose a valid API key header that is not reserved');
      }
      const { token, key, ...rest } = config;
      return { credentials: id === 'token' ? { token } : id === 'header' ? { key } : {}, config: rest, account: { label: url.host } };
    },
    authorize(req, conn) {
      if (id === 'token') req.headers.set('authorization', `Bearer ${conn.credentials.token}`);
      if (id === 'header') req.headers.set(conn.config.header, conn.credentials.key);
    },
  };
}

export default function setup(ctx: PluginContext) {
  return { services: [{
    id: 'mcp', name: 'MCP server', kind: 'mcp' as const, description: 'Tools, resources and prompts over HTTP',
    baseUrl: (conn: Connection) => conn.config.endpoint,
    authMethods: [ctx.mcp.oauth(),
      direct('token', 'Bearer token', [{ key: 'token', label: 'Token', type: 'secret', required: true }]),
      direct('header', 'API key (header)', [{ key: 'header', label: 'Header name', required: true, default: 'X-API-Key' }, { key: 'key', label: 'API key', type: 'secret', required: true }]),
      direct('none', 'No authentication', []),
    ],
  }] };
}
