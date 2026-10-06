import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** SWITCHBOARD_<name>, or HUB_<name> from before the rename. */
const env = new Proxy({} as Record<string, string | undefined>, {
  get: (_t, name: string) => process.env[`SWITCHBOARD_${name}`] ?? process.env[`HUB_${name}`],
});

const dataDir = path.resolve(env.DATA_DIR ?? path.join(root, '.data'));
const port = Number(env.PORT ?? 8770);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  root,
  dataDir,
  port,
  host: env.HOST ?? '0.0.0.0',
  publicUrl,
  secure: publicUrl.startsWith('https://'),
  adminUsername: env.ADMIN_USERNAME ?? 'admin',
  /** 32 bytes as hex or base64. When unset a key is generated in the data dir. */
  secretKey: env.SECRET_KEY,
  sessionTtlSecs: Number(env.SESSION_TTL_SECS ?? 60 * 60 * 24 * 14),
  builtinPluginsDir: path.resolve(env.BUILTIN_PLUGINS_DIR ?? path.join(root, 'plugins')),
  webDir: path.resolve(env.WEB_DIR ?? path.join(root, 'web', 'dist')),
  /** Optional token for installing/updating plugins from private repositories and higher rate limits. */
  githubToken: env.GITHUB_TOKEN,
  /** Days to keep the audit trail; 0 keeps it forever. */
  auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS ?? 90),
  /** Watch plugin directories and reload on change. */
  watchPlugins: (env.WATCH_PLUGINS ?? 'true') !== 'false',
};

export const callbackUrl = `${config.publicUrl}/oauth/callback`;
