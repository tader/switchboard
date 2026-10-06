import type { PluginContext } from '../../server/plugins/api.ts';
import type * as OAuth2 from '../oauth2/index.ts';

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ');

export default function setup(ctx: PluginContext) {
  const oauth = ctx.require<typeof OAuth2>('oauth2');
  const { clientId, clientSecret } = ctx.settings;
  const shared = {
    clientId: () => clientId,
    clientSecret: () => clientSecret,
    tokenUrl: 'https://accounts.spotify.com/api/token',
    tokenAuth: 'basic' as const,
  };

  return {
    services: [
      {
        id: 'spotify',
        name: 'Spotify',
        description: 'Playback, playlists and library',
        icon: 'icon.svg',
        docsUrl: 'https://developer.spotify.com/documentation/web-api',
        baseUrl: 'https://api.spotify.com/v1',
        allowedHosts: ['api.spotify.com'],
        // Community-maintained, kept in sync with Spotify's reference.
        openapi: 'https://raw.githubusercontent.com/sonallux/spotify-web-api/main/fixed-spotify-open-api.yml',
        authMethods: [
          oauth.authorizationCode({
            ...shared,
            id: 'oauth',
            name: 'Sign in with Spotify',
            unavailable: clientId ? undefined : 'An administrator needs to set up a Spotify app first',
            fields: [{ key: 'scopes', label: 'Scopes', type: 'textarea', advanced: true, default: SCOPES }],
            authorizeUrl: 'https://accounts.spotify.com/authorize',
            scopes: (c) => String(c.scopes || SCOPES).split(/\s+/).filter(Boolean),
            // Lets the user pick another account instead of silently reusing the signed-in one.
            authorizeParams: { show_dialog: 'true' },
            async identify(creds) {
              const res = await fetch('https://api.spotify.com/v1/me', { headers: { authorization: `Bearer ${creds.accessToken}` } });
              if (!res.ok) return undefined;
              const u = await res.json();
              return { id: u.id, label: u.email ?? u.display_name ?? u.id, avatarUrl: u.images?.[0]?.url };
            },
          }),
          oauth.clientCredentials({
            ...shared,
            id: 'app',
            name: 'App only',
            description: 'Catalog search and metadata, no personal data',
            unavailable: clientId && clientSecret ? undefined : 'An administrator needs to set up a Spotify app with a client secret first',
            label: () => 'Spotify catalog',
            identify: () => ({ id: 'app', label: 'Spotify catalog' }),
          }),
        ],
      },
    ],
  };
}
