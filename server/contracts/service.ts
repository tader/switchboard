import { peerConnection } from "../peers.ts";
import { contractCredentialsChanged } from "./auth-revision.ts";
import { sharedConnection } from "../peer-settings.ts";
import { peerRoute } from "../peer-protocol.ts";
import { peerContractSource } from "./relay.ts";
import { db, one } from "../db.ts";
import { getConnectionRow, loadConnection } from "../connections.ts";
import { execute } from "../proxy.ts";
import {
  onCredentialsChange,
  onConnectionChange,
} from "../connection-events.ts";
import { onAccessChange } from "../access-events.ts";
import { ContractPushSources } from "./push.ts";
import { ContractStore } from "./store.ts";
import { ContractCollectors } from "./runtime.ts";
function failure(code: string): never {
  throw Object.assign(Error(code), { code });
}
export function activityFor(connection: string) {
  const now = Date.now();
  const candidates = db
    .prepare(
      "SELECT s.owner,s.active_until,s.poll_until,a.principal FROM contract_subscriptions s JOIN contract_subscription_access a ON a.id=s.id WHERE s.poll_until>? AND EXISTS(SELECT 1 FROM json_each(s.connections) WHERE value=?)",
    )
    .all(now, connection) as any[];
  let validUser: any,
    activeUntil = 0,
    pollUntil = 0;
  for (const row of candidates) {
    const user = one(
      "SELECT * FROM users WHERE id=? AND disabled=0",
      row.owner,
    );
    if (!user) continue;
    try {
      const current = getConnectionRow(row.owner, connection);
      if (current.peer_id)
        peerConnection(
          row.owner,
          current.peer_id,
          current.remote_connection_id,
        );
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
    } else {
      try {
        const p = JSON.parse(row.principal);
        if (
          !Array.isArray(p) ||
          p.length !== 4 ||
          p[0] !== "peer" ||
          !p.slice(1).every((x) => typeof x === "string" && x)
        )
          continue;
        if (sharedConnection(p[1], connection).user_id !== row.owner) continue;
      } catch {
        continue;
      }
    }
    validUser = user;
    activeUntil = Math.max(activeUntil, row.active_until);
    pollUntil = Math.max(pollUntil, row.poll_until);
  }
  if (!validUser) return failure("access_revoked");
  return {
    user: validUser,
    activeForMs: Math.min(90000, Math.max(0, activeUntil - now)),
    pollForMs: Math.min(990000, Math.max(0, pollUntil - now)),
  };
}
function actor(connection: string) {
  return activityFor(connection).user;
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
        if (getConnectionRow(user.id, connection).peer_id)
          return failure("collector_not_supported");
        const { conn, service } = loadConnection(user.id, connection);
        const definition = service.contracts;
        if (!definition?.collect)
          throw Object.assign(Error("collector_not_supported"), {
            code: "collector_not_supported",
          });
        const available = await definition.available(conn);
        if (!available.some((name) => definition.operations[name]?.readOnly))
          return failure("collector_not_supported");
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
          if (e?.status === 401 || e?.status === 403)
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
let pushes: ContractPushSources | undefined;
export function pushSources() {
  if (!pushes)
    pushes = new ContractPushSources(
      new ContractStore(db),
      (connection) => {
        const user = actor(connection);
        const row = getConnectionRow(user.id, connection);
        if (row.peer_id)
          return peerContractSource(connection, row, () =>
            activityFor(connection),
          );
        const { conn, service } = loadConnection(user.id, connection);
        const definition = service.contracts;
        return {
          check() {
            actor(connection);
          },
          watch: definition?.watch
            ? (checkpoint, publish, signal) =>
                peerRoute.exit(async () => {
                  const available = await definition.available(conn);
                  if (
                    !available.some(
                      (name) => definition.operations[name]?.readOnly,
                    )
                  )
                    return failure("watch_not_supported");
                  try {
                    await definition.watch!(
                      { checkpoint },
                      {
                        connection: conn,
                        signal,
                        publish,
                        request: async (input) => {
                          actor(connection);
                          return (
                            await execute(user, connection, input, signal)
                          ).response;
                        },
                      },
                    );
                  } catch (e: any) {
                    if (e?.status === 401 || e?.status === 403)
                      return failure("authentication_required");
                    throw e;
                  }
                })
            : undefined,
        };
      },
      collectors(),
    );
  return pushes;
}
export function startContractCollectors() {
  const r = collectors(),
    p = pushSources();
  r.start();
  p.start();
  const off = onCredentialsChange((id, changed) => {
    if (!changed) return;
    contractCredentialsChanged(id);
    r.credentialsChanged(id);
    p.reset(id);
  });
  const changed = onConnectionChange((id) => p.reset(id));
  const access = onAccessChange(() => p.reset());
  return async () => {
    off();
    changed();
    access();
    await Promise.all([r.stop(), p.stop()]);
    runtime = undefined;
    pushes = undefined;
  };
}
export function bindActivity(owner: string, id: string, principal: string) {
  const store = new ContractStore(db);
  const sub = store.subscription(owner, id);
  db.prepare(
    "INSERT INTO contract_subscription_access(id,principal) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET principal=excluded.principal",
  ).run(id, principal);
  for (const connection of sub.connections)
    if (collectors().state(connection).error === "access_revoked") {
      collectors().credentialsChanged(connection);
      pushes?.reset(connection);
    }
}
