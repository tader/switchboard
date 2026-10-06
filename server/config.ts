import path from 'node:path';

const env = process.env;
const root = path.resolve(import.meta.dirname, '..');

const dataDir = path.resolve(env.HUB_DATA_DIR ?? path.join(root, '.data'));
const port = Number(env.HUB_PORT ?? 8770);
const publicUrl = (env.HUB_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  root,
  dataDir,
  port,
  host: env.HUB_HOST ?? '0.0.0.0',
  publicUrl,
  secure: publicUrl.startsWith('https://'),
  adminUsername: env.HUB_ADMIN_USERNAME ?? 'admin',
  /** 32 bytes as hex or base64. When unset a key is generated in the data dir. */
  secretKey: env.HUB_SECRET_KEY,
  sessionTtlSecs: Number(env.HUB_SESSION_TTL_SECS ?? 60 * 60 * 24 * 14),
  builtinPluginsDir: path.resolve(env.HUB_BUILTIN_PLUGINS_DIR ?? path.join(root, 'plugins')),
  webDir: path.resolve(env.HUB_WEB_DIR ?? path.join(root, 'web', 'dist')),
  /** Optional token for installing/updating plugins from private repositories and higher rate limits. */
  githubToken: env.HUB_GITHUB_TOKEN,
  /** Days to keep the audit trail; 0 keeps it forever. */
  auditRetentionDays: Number(env.HUB_AUDIT_RETENTION_DAYS ?? 90),
  /** Watch plugin directories and reload on change. */
  watchPlugins: (env.HUB_WATCH_PLUGINS ?? 'true') !== 'false',
};

export const callbackUrl = `${config.publicUrl}/oauth/callback`;
