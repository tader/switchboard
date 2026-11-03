import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
export const CONTRACT_PEER_SCHEMA = `
CREATE TABLE contract_auth_versions(connection TEXT PRIMARY KEY,revision TEXT NOT NULL);
ALTER TABLE contract_subscription_access ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX contract_peer_subscription_key ON contract_subscription_access(principal,client_key) WHERE client_key IS NOT NULL;
`;
export function contractAuthRevision(connection: string) {
  let row = db
    .prepare("SELECT revision FROM contract_auth_versions WHERE connection=?")
    .get(connection) as any;
  if (!row) {
    row = { revision: randomUUID() };
    db.prepare("INSERT INTO contract_auth_versions VALUES(?,?)").run(
      connection,
      row.revision,
    );
  }
  return row.revision as string;
}
export function contractCredentialsChanged(connection: string) {
  db.prepare(
    "INSERT INTO contract_auth_versions VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET revision=excluded.revision",
  ).run(connection, randomUUID());
}
