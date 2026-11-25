import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
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

export async function publicOAuthFetch(url: URL, init: RequestInit | undefined, signal: AbortSignal, trust?: {ca: string[]; allowPrivate?: boolean}): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || (!trust?.allowPrivate && addresses.some(a => privateAddress(a.address)))) throw badRequest('OAuth discovery points to a private or unresolved address');
  const address = addresses[0];
  const headers = new Headers(init?.headers);
  headers.set('accept-encoding', 'identity');
  const body = init?.body;
  if (body != null && typeof body !== 'string' && !(body instanceof URLSearchParams) && !(body instanceof Uint8Array)) throw badRequest('Unsupported OAuth request body');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      ...(trust ? {agent:false,ca:trust.ca,allowPartialTrustChain:true} : {}), method: init?.method ?? 'GET', headers: Object.fromEntries(headers), signal,
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

/** Inspect only TLS; no HTTP data is sent before approval. Reuse the public DNS policy. */
export async function inspectMetadataCertificate(url: URL, allowPrivate: boolean, ca?: string[]): Promise<string> {
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true});
  if(!addresses.length || (!allowPrivate && addresses.some(a=>privateAddress(a.address)))) throw badRequest('OAuth discovery points to a private or unresolved address');
  return new Promise((resolve,reject)=>{
    const socket=tls.connect({host:addresses[0].address,port:Number(url.port||443),servername:net.isIP(host)?undefined:host,rejectUnauthorized:!!ca,ca,allowPartialTrustChain:true},()=>{
      try {
        let cert=socket.getPeerCertificate(true);
        const mismatch=tls.checkServerIdentity(host,cert); if(mismatch) throw mismatch;
        const seen=new Set<string>(); let chosen:string|undefined;
        while(cert?.raw && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256); const x=new X509Certificate(cert.raw);
          if(Date.now()<Date.parse(x.validFrom)||Date.now()>Date.parse(x.validTo)) throw badRequest('Certificate is expired or not yet valid');
          if(x.ca || (x.checkIssued(x)&&x.verify(x.publicKey))) chosen=x.toString();
          cert=cert.issuerCertificate;
        }
        if(!chosen) throw badRequest('No usable issuing certificate was supplied; contact IT');
        resolve(chosen);
      } catch(e){reject(e);} finally{socket.destroy();}
    });
    const deadline=setTimeout(()=>socket.destroy(new Error('Certificate inspection timed out')),5000);
    socket.once('close',()=>clearTimeout(deadline));socket.on('error',reject);
  });
}
