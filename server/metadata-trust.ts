import tls from 'node:tls';
import { X509Certificate, randomUUID } from 'node:crypto';
import { all, run } from './db.ts';
import { badRequest } from './http.ts';

export function metadataAuthorities(origin: string) {
  return [
    ...tls.getCACertificates('default'),
    ...tls.getCACertificates('system'),
    ...all<{ pem: string }>(
      'SELECT pem FROM metadata_certificates WHERE origin = ?',
      origin,
    ).map((r) => r.pem),
  ];
}
export function certificateFailure(error: any): boolean {
  return [
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ].includes(error?.code ?? error?.cause?.code);
}
const reviews = new Map<
  string,
  { session: string; origin: string; url: string; pem: string; expires: number }
>();
export function offerCertificate(session: string, url: string, pem: string) {
  for (const [id, r] of reviews) if (r.expires < Date.now()) reviews.delete(id);
  if (reviews.size >= 100)
    throw badRequest('Too many certificate reviews; try again later');
  const origin = new URL(url).origin;
  const id = randomUUID();
  reviews.set(id, { session, origin, url, pem, expires: Date.now() + 300000 });
  return { reviewToken: id, origin, ...certificateDetails(pem) };
}
export function takeCertificate(session: string, id: string) {
  const r = reviews.get(id);
  if (!r || r.session !== session || r.expires < Date.now())
    throw badRequest('Certificate review expired; review it again');
  reviews.delete(id);
  return r;
}
export function certificateDetails(pem: string) {
  const c = new X509Certificate(pem);
  return {
    subject: c.subject,
    issuer: c.issuer,
    validFrom: c.validFrom,
    validTo: c.validTo,
    fingerprint: c.fingerprint256,
  };
}
export function saveCertificate(origin: string, pem: string, userId: string) {
  const id = randomUUID();
  run(
    'INSERT INTO metadata_certificates(id,origin,pem,approved_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(origin) DO UPDATE SET id=excluded.id,pem=excluded.pem,approved_by=excluded.approved_by,created_at=excluded.created_at',
    id,
    origin,
    pem,
    userId,
    Date.now(),
  );
  run(
    'INSERT INTO metadata_certificate_events(origin,fingerprint,event,user_id,created_at) VALUES(?,?,?,?,?)',
    origin,
    certificateDetails(pem).fingerprint,
    'approved',
    userId,
    Date.now(),
  );
}
