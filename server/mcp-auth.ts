import {
  auth, checkResourceAllowed, computeScopeUnion, extractWWWAuthenticateParams, validateAuthorizationResponseIssuer,
  type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { callbackUrl, config } from './config.ts';
import { badRequest, HttpError } from './http.ts';
import { mcpEndpoint, oauthFetch, validateOAuthUrl } from './mcp-network.ts';
import type { AuthMethod, ConnectArgs, Field } from './plugins/api.ts';

export const mcpClientMetadataUrl = `${config.publicUrl}/oauth/mcp-client-metadata`;
export const mcpClientMetadata = {
  client_id: mcpClientMetadataUrl, client_name: 'Switchboard',
  redirect_uris: [callbackUrl], grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web' as const,
};

interface OAuthState {
  clients: Record<string, StoredOAuthClientInformation>;
  tokens?: StoredOAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
}

/** One provider per flow/authorization; pending state and credentials are encrypted by connections.ts. */
function providerFor(args: ConnectArgs, state: OAuthState, interactive: boolean, signal?: AbortSignal) {
  const endpoint = mcpEndpoint(args.config.endpoint);
  const allowPrivate = args.config.allowPrivateOAuth === true;
  let redirect: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: args.callbackUrl,
    clientMetadataUrl: config.secure && args.callbackUrl === callbackUrl ? mcpClientMetadataUrl : undefined,
    clientMetadata: { ...mcpClientMetadata, redirect_uris: [args.callbackUrl], scope: args.config.scope || undefined },
    state: () => args.state,
    clientInformation(ctx) {
      if (!ctx) return undefined;
      if (args.config.clientId) {
        if (!args.config.issuer || args.config.issuer !== ctx.issuer) throw badRequest('The discovered OAuth issuer does not match the configured issuer');
        return { client_id: args.config.clientId, ...(args.config.clientSecret ? { client_secret: args.config.clientSecret } : {}), issuer: ctx.issuer };
      }
      return state.clients[ctx.issuer];
    },
    saveClientInformation(info, ctx) {
      if (!ctx) throw badRequest('OAuth registration did not identify its issuer');
      state.clients[ctx.issuer] = info;
    },
    tokens(ctx) { return !ctx || state.tokens?.issuer === ctx.issuer ? state.tokens : undefined; },
    saveTokens(tokens) {
      if (tokens.token_type.toLowerCase() !== 'bearer') throw badRequest('This MCP connection requires bearer OAuth tokens');
      state.tokens = tokens;
      state.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    },
    async redirectToAuthorization(url) {
      await validateOAuthUrl(url, endpoint, allowPrivate);
      if (!interactive) throw new HttpError(401, 'Reconnect this MCP connection to grant access');
      redirect = url.href;
    },
    saveCodeVerifier(verifier) { state.verifier = verifier; },
    codeVerifier() {
      if (!state.verifier) throw badRequest('The OAuth sign-in has expired');
      return state.verifier;
    },
    async saveDiscoveryState(discovery) {
      await validateOAuthUrl(discovery.authorizationServerUrl, endpoint, allowPrivate);
      for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'issuer'] as const) {
        const value = discovery.authorizationServerMetadata?.[key];
        if (typeof value === 'string') await validateOAuthUrl(value, endpoint, allowPrivate);
      }
      if (args.config.issuer && (discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl) !== args.config.issuer) {
        throw badRequest('The discovered OAuth issuer does not match the configured issuer');
      }
      state.discovery = discovery;
    },
    discoveryState: () => state.discovery,
    async validateResourceURL(serverUrl, resource) {
      const requested = new URL(serverUrl);
      if (requested.href !== endpoint.href || (resource && !checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource }))) {
        throw badRequest('OAuth resource metadata does not match the MCP endpoint');
      }
      return endpoint;
    },
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') state.clients = {};
      if (scope === 'all' || scope === 'tokens') { delete state.tokens; delete state.expiresAt; }
      if (scope === 'all' || scope === 'verifier') delete state.verifier;
      if (scope === 'all' || scope === 'discovery') delete state.discovery;
    },
  };
  return { provider, endpoint, fetchFn: oauthFetch(endpoint, allowPrivate, signal), redirect: () => redirect };
}

const commonFields: Field[] = [
  { key: 'endpoint', label: 'MCP endpoint', type: 'url', required: true, placeholder: 'https://example.com/mcp' },
  { key: 'allowPrivateOAuth', label: 'Allow OAuth servers on private networks', type: 'boolean', advanced: true },
];

export function mcpOAuth(): AuthMethod {
  return {
    id: 'oauth', name: 'OAuth',
    fields: [...commonFields,
      { key: 'scope', label: 'Scopes', advanced: true },
      { key: 'issuer', label: 'OAuth issuer', type: 'url', advanced: true, description: 'Required for a pre-registered client' },
      { key: 'clientId', label: 'Client ID', advanced: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', advanced: true },
    ],
    async connect(args) {
      if (args.config.clientId && !args.config.issuer) throw badRequest('Enter the issuer for the pre-registered OAuth client');
      const state: OAuthState = { clients: {} };
      const previous = args.connection;
      if (previous && previous.config.endpoint === args.config.endpoint) {
        args.config.scope = computeScopeUnion(args.config.scope, previous.credentials?.requiredScope);
        if (!args.config.clientSecret && args.config.clientId === previous.config.clientId && args.config.issuer === previous.config.issuer) args.config.clientSecret = previous.credentials?.clientSecret;
      }
      const p = providerFor(args, state, true);
      // Read the server's challenge without credentials, including noncanonical
      // resource metadata locations and required scopes.
      const probe = await p.fetchFn(p.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'oauth-discovery', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }) });
      const challenge = extractWWWAuthenticateParams(probe);
      await probe.body?.cancel();
      await auth(p.provider, { serverUrl: p.endpoint, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: computeScopeUnion(args.config.scope, challenge.scope), fetchFn: p.fetchFn, forceReauthorization: true });
      if (!p.redirect()) throw badRequest('The OAuth server did not provide a sign-in URL');
      return { redirect: p.redirect()!, pending: state };
    },
    async callback(args) {
      if (args.params.state !== args.state) throw badRequest('OAuth state does not match this sign-in');
      const state = args.pending as OAuthState;
      if (!state?.discovery || !state.verifier) throw badRequest('The OAuth sign-in has expired');
      validateAuthorizationResponseIssuer({
        iss: args.params.iss,
        expectedIssuer: state.discovery.authorizationServerMetadata?.issuer,
        issParameterSupported: state.discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true,
      });
      if (args.params.error) throw badRequest('Authorization was declined; reconnect to try again');
      if (!args.params.code) throw badRequest('The OAuth server did not return a code');
      const p = providerFor(args, state, true);
      await auth(p.provider, { serverUrl: p.endpoint, authorizationCode: args.params.code, iss: args.params.iss, fetchFn: p.fetchFn });
      delete state.verifier;
      const { clientSecret, ...publicConfig } = args.config;
      return { credentials: { ...state, ...(clientSecret ? { clientSecret } : {}) }, config: publicConfig, account: { label: p.endpoint.host } };
    },
    async authorize(req, conn, opts) {
      const state = structuredClone(conn.credentials) as OAuthState;
      const expired = state.expiresAt !== undefined && state.expiresAt <= Date.now() + 30_000;
      if (!state.tokens || expired || opts.force) {
        const args = { config: { ...conn.config, clientSecret: conn.credentials?.clientSecret }, callbackUrl, state: '', connection: conn };
        const p = providerFor(args, state, false, opts.signal);
        await auth(p.provider, { serverUrl: p.endpoint, fetchFn: p.fetchFn });
      }
      if (!state.tokens) throw new HttpError(401, 'Reconnect this MCP connection to grant access');
      req.headers.set('authorization', `Bearer ${state.tokens.access_token}`);
      return { credentials: { ...state, ...(conn.credentials?.clientSecret ? { clientSecret: conn.credentials.clientSecret } : {}) } };
    },
  };
}
