import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createUnzip, createBrotliDecompress } from 'node:zlib';
import { badRequest } from './http.ts';

export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!net.isIPv6(ip) || ip.includes('%')) return true;
  const v = new URL('http://[' + ip + ']').hostname.slice(1, -1).toLowerCase();
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice(7);
    if (net.isIPv4(mapped)) return privateAddress(mapped);
    const parts = mapped.split(':');
    if (parts.length === 2) {
      const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
      return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
  }
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

export async function publicOAuthFetch(url: URL, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw badRequest('OAuth discovery points to a private or unresolved address');
  const address = addresses[0];
  const headers = new Headers(init?.headers);
  headers.set('accept-encoding', 'identity');
  const body = init?.body;
  if (body != null && typeof body !== 'string' && !(body instanceof URLSearchParams) && !(body instanceof Uint8Array)) throw badRequest('Unsupported OAuth request body');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: init?.method ?? 'GET', headers: Object.fromEntries(headers), signal,
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    }, res => {
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const noBody = [204, 205, 304].includes(res.statusCode!) || init?.method === 'HEAD';
        if (noBody) res.resume();
        let body: Readable = res;
        const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
        const decoder = encoding === 'gzip' || encoding === 'deflate' ? createUnzip() : encoding === 'br' ? createBrotliDecompress() : undefined;
        if (!noBody && decoder) {
          res.on('error', error => decoder.destroy(error));
          decoder.on('close', () => res.destroy());
          body = res.pipe(decoder);
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
        }
        resolve(new Response(noBody ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: res.statusCode!, headers: responseHeaders }));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on('error', reject);
    req.end(body instanceof URLSearchParams ? body.toString() : body);
  });
}

/** Count decoded UTF-16 units, matching the existing metadata limit. */
export async function limitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      const text = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      size += text.length;
      if (size > limit) { await reader.cancel(); throw badRequest('The client metadata document is too large'); }
      chunks.push(text);
      if (next.done) return chunks.join('');
    }
  } finally { reader.releaseLock(); }
}
