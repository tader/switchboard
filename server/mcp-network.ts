import { privateAddress, publicOAuthFetch } from './public-network.ts';
import dns from 'node:dns/promises';
import net from 'node:net';
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
