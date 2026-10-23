import { badRequest } from './http.ts';

// Browser/document schemes are not native OAuth application callbacks.
const UNSAFE = new Set(['javascript:', 'vbscript:', 'data:', 'blob:', 'file:', 'filesystem:', 'about:', 'view-source:', 'chrome:', 'chrome-extension:', 'edge:', 'resource:', 'ftp:', 'ftps:', 'ws:', 'wss:']);
export function callbackUri(value: unknown): URL {
  let url: URL;
  try { if (typeof value !== 'string') throw Error(); url = new URL(value); }
  catch { throw badRequest('redirect_uri must be a URL'); }
  if (UNSAFE.has(url.protocol) || url.username || url.password || url.hash) throw badRequest('Unsupported redirect URI');
  return url;
}
