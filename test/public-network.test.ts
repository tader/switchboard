import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { privateAddress, publicOAuthFetch, limitedText } from '../server/public-network.ts';

test('public address policy handles canonical and expanded mapped IPv6', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fe90::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808']) assert.equal(privateAddress(ip), false, ip);
});

test('public fetch pins the checked DNS answer and preserves the TLS hostname', async t => {
  let resolutions = 0;
  t.mock.method(dns, 'lookup', async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; });
  t.mock.method(https, 'request', (url: URL, options: any, done: any) => {
    assert.equal(url.hostname, 'metadata.example');
    options.lookup(url.hostname, {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup(url.hostname, { all: true }, (error: unknown, addresses: unknown[]) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    const req = new EventEmitter() as any;
    req.end = () => { const response = Readable.from([Buffer.from('{"ok":true}')]) as any; response.statusCode = 200; response.rawHeaders = ['content-type', 'application/json']; done(response); };
    return req;
  });
  const response = await publicOAuthFetch(new URL('https://metadata.example/client.json'), undefined, AbortSignal.timeout(1000));
  assert.deepEqual(await response.json(), { ok: true }); assert.equal(resolutions, 1);
});

test('metadata size limits cancel streaming bodies while preserving multibyte text', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65537))); }, cancel() { cancelled = true; } }));
  await assert.rejects(limitedText(response, 65536), /too large/); assert.equal(cancelled, true);
  const bytes = new TextEncoder().encode('€'.repeat(30000));
  const unicode = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 1)); c.enqueue(bytes.subarray(1)); c.close(); } }));
  assert.equal((await limitedText(unicode, 65536)).length, 30000);
});

test('public fetch rejects private DNS answers before opening a socket', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }]);
  t.mock.method(https, 'request', () => { throw Error('socket must not be opened'); });
  await assert.rejects(publicOAuthFetch(new URL('https://metadata.example/client.json'), undefined, AbortSignal.timeout(1000)), /private or unresolved/);
});

test('public fetch preserves compressed metadata compatibility and rejects invalid status safely', async t => {
  const { gzipSync } = await import('node:zlib');
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  let status = 200;
  t.mock.method(https, 'request', (_url: URL, _options: unknown, done: any) => {
    const req = new EventEmitter() as any;
    req.end = () => { const response = Readable.from([gzipSync('{"ok":true}')]) as any; response.statusCode = status; response.rawHeaders = ['content-encoding', 'gzip']; done(response); };
    return req;
  });
  const response = await publicOAuthFetch(new URL('https://metadata.example/client.json'), undefined, AbortSignal.timeout(1000));
  assert.equal(response.headers.has('content-encoding'), false);
  assert.deepEqual(await response.json(), { ok: true });
  status = 999;
  await assert.rejects(publicOAuthFetch(new URL('https://metadata.example/client.json'), undefined, AbortSignal.timeout(1000)), /status/);
});
