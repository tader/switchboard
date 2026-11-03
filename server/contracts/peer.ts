import { getConnectionRow } from "../connections.ts";
import { refreshPeerContract } from "./relay.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";
import type { WebSocketAccess } from "../websocket-access.ts";
import type { Caller } from "../audit.ts";
import { record } from "../audit.ts";
import { HttpError, badRequest } from "../http.ts";
import { onConnectionChange } from "../connection-events.ts";
import { onAccessChange } from "../access-events.ts";
import { onPeersChanged } from "../peer-settings.ts";
import { ContractStore, ACTIVITY_LEASE, IDLE_GRACE } from "./store.ts";
import { callContract, contractFailure, describeContract } from "./engine.ts";
import { bindActivity, collectors, pushSources } from "./service.ts";
function owned(access: WebSocketAccess, id: unknown, connection: string) {
  if (typeof id !== "string") throw badRequest("Subscription required");
  const store = new ContractStore(db);
  const s = store.subscription(access.user.id, id);
  const row = db
    .prepare("SELECT principal FROM contract_subscription_access WHERE id=?")
    .get(id) as any;
  if (
    row?.principal !== access.principal ||
    s.connections.length !== 1 ||
    s.connections[0] !== connection
  )
    throw new HttpError(404, "subscription_not_found");
  access.check(connection);
  return s;
}
export async function handleContractPeer(
  access: WebSocketAccess,
  connection: string,
  payload: any,
  signal: AbortSignal,
  caller: Caller,
) {
  if (!config.sharedContracts)
    throw new HttpError(501, "contract_peer_upgrade_required");
  const store = new ContractStore(db);
  access.check(connection);
  try {
    switch (payload.action) {
      case "describe":
        return describeContract(
          access,
          connection,
          signal,
          caller,
          payload.operation,
        );
      case "call": {
        const started = Date.now();
        let status = 500;
        try {
          const r = await callContract(
            access,
            connection,
            payload.input,
            signal,
            caller,
            collectors(),
          );
          status = r.status;
          return r;
        } catch (error) {
          status = contractFailure(error).status;
          throw error;
        } finally {
          record({
            userId: access.user.id,
            caller,
            connection: {
              id: connection,
              name: connection,
              serviceId: "contracts",
            },
            method: "CONTRACT",
            status,
            durationMs: Date.now() - started,
          });
        }
      }
      case "open": {
        if (
          typeof payload.clientKey !== "string" ||
          !payload.clientKey ||
          payload.clientKey.length > 128
        )
          throw badRequest("Client key required");
        const existing = db
          .prepare(
            "SELECT id FROM contract_subscription_access WHERE principal=? AND client_key=?",
          )
          .get(access.principal, payload.clientKey) as any;
        if (existing) {
          owned(access, existing.id, connection);
          return { id: existing.id, cursor: store.head() };
        }
        const sub = store.create(access.user.id, [connection]);
        bindActivity(access.user.id, sub.id, access.principal);
        db.prepare(
          "UPDATE contract_subscription_access SET client_key=? WHERE id=?",
        ).run(payload.clientKey, sub.id);
        return sub;
      }
      case "refresh": {
        owned(access, payload.id, connection);
        const row = getConnectionRow(access.user.id, connection);
        return row.peer_id
          ? refreshPeerContract(connection, row, access.user, signal)
          : collectors().refresh(connection, true);
      }
      case "activity": {
        const s = owned(access, payload.id, connection);
        const active = payload.activeForMs,
          poll = payload.pollForMs;
        if (
          !Number.isFinite(active) ||
          !Number.isFinite(poll) ||
          active < 0 ||
          active > ACTIVITY_LEASE ||
          poll < active ||
          poll > ACTIVITY_LEASE + IDLE_GRACE
        )
          throw badRequest("Invalid activity lease");
        db.prepare(
          "UPDATE contract_subscriptions SET active_until=?,poll_until=? WHERE id=?",
        ).run(Date.now() + active, Date.now() + poll, s.id);
        bindActivity(access.user.id, s.id, access.principal);
        await pushSources().tick();
        return { saved: true };
      }
      case "close": {
        const s = owned(access, payload.id, connection);
        store.remove(access.user.id, s.id);
        await pushSources().tick();
        return { deleted: true };
      }
      case "read": {
        const s = owned(access, payload.id, connection);
        const cursor = payload.cursor;
        if (!Number.isSafeInteger(cursor)) throw badRequest("Invalid cursor");
        let wake!: () => void;
        const pending = new Promise<void>((r) => (wake = r));
        const off = store.onChange(() => wake()),
          accessOff = onAccessChange(() => wake()),
          peerOff = onPeersChanged(() => wake()),
          connOff = onConnectionChange(() => wake());
        const timer = setTimeout(() => wake(), 20000);
        const aborted = () => wake();
        signal.addEventListener("abort", aborted, { once: true });
        try {
          let page = store.read(access.user.id, s.id, cursor, 100);
          if (
            !page.events.length &&
            !signal.aborted &&
            collectors().state(connection).status !== "auth_required"
          ) {
            await pending;
            owned(access, s.id, connection);
            page = store.read(access.user.id, s.id, cursor, 100);
          }
          return { ...page, source: collectors().state(connection) };
        } finally {
          clearTimeout(timer);
          off();
          accessOff();
          peerOff();
          connOff();
          signal.removeEventListener("abort", aborted);
        }
      }
      default:
        throw badRequest("Unknown contract peer action");
    }
  } catch (error) {
    const f = contractFailure(error);
    throw Object.assign(new HttpError(f.status, f.code), { code: f.code });
  }
}
