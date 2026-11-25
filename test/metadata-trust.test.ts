import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { once } from 'node:events';
import {
  inspectMetadataCertificate,
  publicOAuthFetch,
} from '../server/public-network.ts';

test('metadata certificate inspection sends no HTTP and scoped CA trust retains hostname verification', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-tls-'));
  const openssl = (args: string[]) =>
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=Example Workplace CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=localhost',
  ]);
  fs.writeFileSync(
    path.join(dir, 'ext'),
    'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '1',
    '-extfile',
    'ext',
  ]);
  let requests = 0;
  const ca = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, 'leaf.key')),
      cert: fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8') + ca,
    },
    (_req, res) => {
      requests++;
      res.end(
        JSON.stringify({
          client_id: `https://localhost:${(server.address() as any).port}/client.json`,
          redirect_uris: ['http://localhost:9000/callback'],
        }),
      );
    },
  );
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port,
    url = new URL(`https://localhost:${port}/client.json`);
  try {
    await assert.rejects(
      publicOAuthFetch(url, undefined, AbortSignal.timeout(3000), {
        ca: [],
        allowPrivate: true,
      }),
    );
    const candidate = await inspectMetadataCertificate(url, true);
    assert.equal(candidate.trim(), ca.trim());
    assert.equal(requests, 0);
    await inspectMetadataCertificate(url, true, [candidate]);
    assert.equal(requests, 0);
    const response = await publicOAuthFetch(
      url,
      undefined,
      AbortSignal.timeout(3000),
      { ca: [candidate], allowPrivate: true },
    );
    assert.ok((await response.json()).client_id);
    assert.equal(requests, 1);
    await assert.rejects(
      inspectMetadataCertificate(
        new URL(`https://127.0.0.1:${port}/client.json`),
        true,
        [candidate],
      ),
      /IP|hostname|altnames/,
    );
    await assert.rejects(inspectMetadataCertificate(url, false), /private/);
    process.env.SWITCHBOARD_DATA_DIR = dir;
    process.env.SWITCHBOARD_PUBLIC_URL = 'http://switchboard.example';
    const database = await import('../server/db.ts');
    const { initDb, one } = database;
    initDb();
    const { initKey } = await import('../server/crypto.ts');
    initKey();
    const { createUser, createSession } = await import('../server/users.ts');
    const { authorizeApi, certificateApi } =
      await import('../server/routes/provider.ts');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.onError((e, c) =>
      c.json(
        { error: e.message, code: (e as any).code },
        (e as any).status ?? 500,
      ),
    );
    app.route('/authorize', authorizeApi);
    app.route('/certificates', certificateApi);
    const admin = createUser('review-admin', 'admin'),
      member = createUser('member', 'user');
    const session = createSession(admin.id),
      other = createSession(member.id);
    const req = async (
      route: string,
      body?: unknown,
      cookie = session,
      method = body ? 'POST' : 'GET',
      site = 'same-origin',
    ) =>
      app.request(route, {
        method,
        headers: {
          cookie: 'switchboard_session=' + cookie,
          'sec-fetch-site': site,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const params = {
      client_id: url.href,
      redirect_uri: 'http://localhost:9000/callback',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    };
    let result = await req('/authorize?' + new URLSearchParams(params));
    assert.equal(
      ((await result.json()) as any).code,
      'oauth_metadata_certificate_untrusted',
    );
    assert.equal(
      (
        await req(
          '/authorize/certificate-review',
          { client_id: url.href },
          other,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          '/authorize/certificate-review',
          { client_id: url.href },
          session,
          'POST',
          'cross-site',
        )
      ).status,
      403,
    );
    result = await req('/authorize/certificate-review', {
      client_id: url.href,
    });
    assert.equal(result.status, 200);
    const review = (await result.json()) as any;
    assert.equal(
      (
        await req(
          '/authorize/certificate-trust',
          { reviewToken: review.reviewToken },
          createSession(admin.id),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req('/authorize/certificate-trust', {
          reviewToken: review.reviewToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req('/authorize/certificate-trust', {
          reviewToken: review.reviewToken,
        })
      ).status,
      400,
    );
    assert.equal(
      (await req('/authorize?' + new URLSearchParams(params))).status,
      200,
    );
    assert.equal(
      (
        await req(
          '/authorize?' +
            new URLSearchParams({
              ...params,
              redirect_uri: 'https://wrong.example/callback',
            }),
        )
      ).status,
      400,
    );
    openssl([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      '42',
      '-out',
      'renewed.pem',
      '-days',
      '1',
      '-extfile',
      'ext',
    ]);
    server.setSecureContext({
      key: fs.readFileSync(path.join(dir, 'leaf.key')),
      cert: fs.readFileSync(path.join(dir, 'renewed.pem'), 'utf8') + ca,
    });
    assert.equal(
      (await req('/authorize?' + new URLSearchParams(params))).status,
      200,
      'renewal under same CA works',
    );
    const { metadataAuthorities, offerCertificate, takeCertificate } =
      await import('../server/metadata-trust.ts');
    assert.ok(metadataAuthorities(url.origin).includes(candidate));
    assert.ok(
      !metadataAuthorities('https://unrelated.example').includes(candidate),
    );
    const expired = offerCertificate(session, url.href, candidate);
    const clock = Date.now();
    t.mock.method(Date, 'now', () => clock + 300001);
    assert.throws(
      () => takeCertificate(session, expired.reviewToken),
      /expired/,
    );
    t.mock.restoreAll();
    const records = (await (await req('/certificates')).json()) as any[];
    assert.equal(records.length, 1);
    assert.equal(
      (
        await req(
          '/certificates/' + records[0].id,
          undefined,
          session,
          'DELETE',
        )
      ).status,
      200,
    );
    result = await req('/authorize?' + new URLSearchParams(params));
    assert.equal(
      ((await result.json()) as any).code,
      'oauth_metadata_certificate_untrusted',
    );
    assert.equal(
      one('SELECT count(*) AS n FROM metadata_certificate_events').n,
      2,
    );
    database.db.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-signed website certificates remain subject to validity checks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-signed-metadata-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(dir, 'key'),
      '-out',
      path.join(dir, 'cert'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=CA:FALSE',
    ],
    { stdio: 'ignore' },
  );
  const pem = fs.readFileSync(path.join(dir, 'cert'), 'utf8');
  const server = https.createServer(
    { key: fs.readFileSync(path.join(dir, 'key')), cert: pem },
    (_req, res) => res.end('{}'),
  );
  server.listen(0);
  await once(server, 'listening');
  const url = new URL(
    `https://localhost:${(server.address() as any).port}/client.json`,
  );
  try {
    assert.equal(
      (await inspectMetadataCertificate(url, true)).trim(),
      pem.trim(),
    );
    const res = await publicOAuthFetch(
      url,
      undefined,
      AbortSignal.timeout(3000),
      { ca: [pem], allowPrivate: true },
    );
    await res.body?.cancel();
    assert.equal(res.status, 200);
    const clock = Date.now();
    t.mock.method(Date, 'now', () => clock + 2 * 86400000);
    await assert.rejects(inspectMetadataCertificate(url, true), /expired/);
  } finally {
    t.mock.restoreAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
