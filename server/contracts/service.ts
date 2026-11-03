import { db, one } from "../db.ts";
import { getConnectionRow, loadConnection } from "../connections.ts";
import { execute } from "../proxy.ts";
import { onCredentialsChange } from "../connection-events.ts";
import { ContractStore } from "./store.ts";
import { ContractCollectors } from "./runtime.ts";
function failure(code: string): never {
  throw Object.assign(Error(code), { code });
}
function actor(connection: string) {
  const now = Date.now();
  const candidates = db
    .prepare(
      "SELECT s.owner,a.principal FROM contract_subscriptions s JOIN contract_subscription_access a ON a.id=s.id WHERE s.poll_until>? AND EXISTS(SELECT 1 FROM json_each(s.connections) WHERE value=?)",
    )
    .all(now, connection) as any[];
  for (const row of candidates) {
    const user = one(
      "SELECT * FROM users WHERE id=? AND disabled=0",
      row.owner,
    );
    if (!user) continue;
    try {
      getConnectionRow(row.owner, connection);
    } catch {
      continue;
    }
    if (row.principal.startsWith("token:")) {
      const token = one(
        "SELECT * FROM api_tokens WHERE id=? AND user_id=?",
        row.principal.slice(6),
        row.owner,
      );
      if (
        !token ||
        token.audience === "mcp" ||
        (token.expires_at && token.expires_at <= now) ||
        (token.connection_ids &&
          !JSON.parse(token.connection_ids).includes(connection))
      )
        continue;
    } else if (row.principal.startsWith("session:")) {
      if (
        !one(
          "SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?",
          row.principal.slice(8),
          row.owner,
          now,
        )
      )
        continue;
    } else continue;
    return user;
  }
  return failure("access_revoked");
}
let runtime: ContractCollectors | undefined;
export function collectors() {
  if (!runtime) {
    runtime = new ContractCollectors(new ContractStore(db), (connection) => ({
      check() {
        actor(connection);
      },
      async collect(checkpoint, signal) {
        const user = actor(connection);
        const { conn, service } = loadConnection(user.id, connection);
        const definition = service.contracts;
        if (!definition?.collect)
          throw Object.assign(Error("collector_not_supported"), {
            code: "collector_not_supported",
          });
        const available = await definition.available(conn);
        if (!available.some((name) => definition.operations[name]?.readOnly))
          return failure("permission_denied");
        try {
          return await definition.collect(
            { checkpoint },
            {
              connection: conn,
              signal,
              request: async (input) => {
                actor(connection);
                return (await execute(user, connection, input, signal))
                  .response;
              },
            },
          );
        } catch (e: any) {
          if (e.status === 401 || e.status === 403)
            throw Object.assign(Error("authentication_required"), {
              code: "authentication_required",
            });
          throw e;
        }
      },
    }));
  }
  return runtime;
}
export function startContractCollectors() {
  const r = collectors();
  r.start();
  const off = onCredentialsChange((id) => r.credentialsChanged(id));
  return async () => {
    off();
    await r.stop();
    runtime = undefined;
  };
}
export function bindActivity(owner: string, id: string, principal: string) {
  const store = new ContractStore(db);
  const sub = store.subscription(owner, id);
  db.prepare(
    "INSERT INTO contract_subscription_access VALUES(?,?) ON CONFLICT(id) DO UPDATE SET principal=excluded.principal",
  ).run(id, principal);
  for (const connection of sub.connections)
    if (collectors().state(connection).error === "access_revoked")
      collectors().credentialsChanged(connection);
}
