import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';
import { badRequest, HttpError } from './http.ts';

export const MCP_TIMEOUT = 120_000;
export const MCP_RESPONSE_LIMIT = 2 * 1024 * 1024;

/** Configured endpoints may be private; OAuth discovery cannot widen that access. */
export function mcpEndpoint(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value ?? '')); } catch { throw badRequest('Enter an absolute MCP endpoint URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw badRequest('MCP endpoints must use HTTP or HTTPS without a username, password or fragment');
  }
  return url;
}

function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
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

export async function validateOAuthUrl(value: string | URL, endpoint: URL, allowPrivate = false): Promise<URL> {
  const url = mcpEndpoint(value);
  // The user explicitly selected this server, including its scheme and private address.
  if (url.origin === endpoint.origin) return url;
  if (url.protocol !== 'https:') throw badRequest('Discovered OAuth endpoints must use HTTPS');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw badRequest('OAuth discovery points to a private or unresolved address');
  }
  return url;
}

/** Bounds both JSON and streaming SSE bodies, including notification traffic. */
export function limitResponse(response: Response, budget: { remaining: number }): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        size += chunk.value.byteLength;
        budget.remaining -= chunk.value.byteLength;
        if (size > MCP_RESPONSE_LIMIT || budget.remaining < 0) {
          await reader.cancel();
          throw new HttpError(502, 'MCP response exceeded the size limit');
        }
        controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function oauthFetch(endpoint: URL, allowPrivate: boolean, signal?: AbortSignal) {
  const budget = { remaining: 8 * MCP_RESPONSE_LIMIT };
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = await validateOAuthUrl(input, endpoint, allowPrivate);
    const signals = [AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])];
    const requestSignal = AbortSignal.any(signals);
    // Pin cross-origin discovery to the public address we checked. A second DNS
    // resolution inside fetch would allow rebinding to a private network.
    const response = url.origin !== endpoint.origin && !allowPrivate
      ? await publicOAuthFetch(url, init, requestSignal)
      : await fetch(url, { ...init, redirect: 'manual', signal: requestSignal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw badRequest('Redirects from MCP and OAuth endpoints are not supported; enter the final endpoint URL');
    }
    return limitResponse(response, budget);
  };
}

async function publicOAuthFetch(url: URL, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
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
        if (typeof options === 'object' && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, res => {
      const responseHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const noBody = [204, 205, 304].includes(res.statusCode!) || init?.method === 'HEAD';
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode!, headers: responseHeaders }));
    });
    req.on('error', reject);
    req.end(body instanceof URLSearchParams ? body.toString() : body);
  });
}
