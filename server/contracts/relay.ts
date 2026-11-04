import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { getPeer, requestPeer } from "../peers.ts";
import { peerRoute } from "../peer-protocol.ts";
import { sha256 } from "../crypto.ts";
import { HttpError } from "../http.ts";
import type { Caller } from "../audit.ts";
import type { PushSource } from "./push.ts";
import { ContractStore } from "./store.ts";
import type { ContractView } from "./engine.ts";
interface Lease {
  user: any;
  activeForMs: number;
  pollForMs: number;
}
interface Checkpoint {
  instance: string;
  connection: string;
  id: string;
  cursor: number;
  generation: string;
}
function caller(connection: string): Caller {
  return {
    source: "call",
    tokenId: "contract-relay:" + connection,
    tokenName: "Contract relay",
    ip: null,
    userAgent: null,
  };
}
function parsed(
  raw: string | undefined,
  instance: string,
  connection: string,
): Checkpoint | undefined {
  try {
    const p = raw ? JSON.parse(raw) : null;
    if (
      p &&
      p.instance === instance &&
      p.connection === connection &&
      typeof p.id === "string" &&
      p.id.length <= 100 &&
      Number.isSafeInteger(p.cursor) &&
      p.cursor >= 0 &&
      typeof p.generation === "string" &&
      p.generation.length <= 100
    )
      return p;
  } catch {}
}
function viewCategories(view: ContractView) {
  return [...new Set(view.operations.map((o) => o.category))];
}
export function peerContractSource(
  connection: string,
  row: any,
  lease: () => Lease,
): PushSource {
  return {
    check() {
      lease();
    },
    watch: (_checkpoint, publish, signal) =>
      peerRoute.exit(async () => {
        const relayUser = lease().user;
        const owner = getPeer(row.peer_id).remoteInstanceId;
        if (typeof owner !== "string") throw new HttpError(503, "peer_offline");
        const rpc = (action: string, data: any = {}, abort = signal) => {
          const current = lease();
          return requestPeer<any>(
            row.peer_id,
            current.user.id,
            "contracts",
            {
              connection: row.remote_connection_id,
              action,
              caller: caller(connection),
              ...data,
            },
            30000,
            abort,
          );
        };
        const description = (await rpc("describe")) as ContractView;
        let state = parsed(_checkpoint, owner, row.remote_connection_id);
        let nextRenew = 0;
        async function open(resync: boolean) {
          const previous = state;
          const sub = await rpc("open", {
            clientKey: sha256(JSON.stringify(["relay", connection])),
          });
          if (typeof sub.id !== "string" || !Number.isSafeInteger(sub.cursor))
            throw new HttpError(502, "invalid_contract_response");
          state = {
            instance: owner,
            connection: row.remote_connection_id,
            id: sub.id,
            cursor: resync || !previous ? sub.cursor : previous.cursor,
            generation:
              resync || !previous ? randomUUID() : previous.generation,
          };
          nextRenew = 0;
          await publish({
            events:
              resync || !previous
                ? viewCategories(description).map((category) => ({
                    sourceId: `peer:${state!.generation}:resync:${category}`,
                    event: {
                      category,
                      type: "resync.required",
                      resourceType: "scope",
                    },
                  }))
                : [],
            checkpoint: JSON.stringify(state),
          });
        }
        try {
          if (!state) await open(true);
          while (!signal.aborted) {
            try {
              if (Date.now() >= nextRenew) {
                const activity = lease();
                await rpc("activity", {
                  id: state!.id,
                  activeForMs: activity.activeForMs,
                  pollForMs: activity.pollForMs,
                });
                nextRenew = Date.now() + 20000;
              }
              const page = await rpc("read", {
                id: state!.id,
                cursor: state!.cursor,
              });
              if (
                !Array.isArray(page.events) ||
                !Number.isSafeInteger(page.cursor) ||
                page.cursor < state!.cursor
              )
                throw new HttpError(502, "invalid_contract_response");
              if (page.events.length || page.cursor !== state!.cursor) {
                const next = { ...state!, cursor: page.cursor };
                await publish({
                  events: page.events.map((event: any) => {
                    if (typeof event.id !== "string" || !/^\d+$/.test(event.id))
                      throw new HttpError(502, "invalid_contract_response");
                    return {
                      sourceId: `peer:${state!.generation}:${event.id}`,
                      event,
                    };
                  }),
                  checkpoint: JSON.stringify(next),
                });
                state = next;
              }
              if (page.source?.status === "auth_required")
                throw Object.assign(Error("authentication_required"), {
                  code:
                    page.source.error === "access_revoked"
                      ? "access_revoked"
                      : "authentication_required",
                });
            } catch (error: any) {
              if (signal.aborted) throw error;
              if (error?.code === "subscription_not_found") {
                await open(false);
                continue;
              }
              if (error?.code === "invalid_cursor") {
                try {
                  await rpc("close", { id: state!.id });
                } catch {}
                await open(true);
                continue;
              }
              throw error;
            }
          }
        } finally {
          if (state) {
            try {
              await requestPeer(
                row.peer_id,
                relayUser.id,
                "contracts",
                {
                  connection: row.remote_connection_id,
                  action: "close",
                  id: state.id,
                  caller: caller(connection),
                },
                2500,
                AbortSignal.timeout(2500),
              );
            } catch {}
          }
        }
      }),
  };
}
export async function refreshPeerContract(
  connection: string,
  row: any,
  user: any,
  signal: AbortSignal,
) {
  const identity = {
    ...caller(connection),
    tokenId: "contract-refresh:" + randomUUID(),
  };
  const rpc = (action: string, input: any = {}, abort = signal) =>
    requestPeer<any>(
      row.peer_id,
      user.id,
      "contracts",
      {
        connection: row.remote_connection_id,
        action,
        caller: identity,
        ...input,
      },
      120000,
      abort,
    );
  const sub = await rpc("open", { clientKey: "refresh:" + randomUUID() });
  try {
    await rpc("activity", { id: sub.id, activeForMs: 0, pollForMs: 30000 });
    const result = await rpc("refresh", { id: sub.id });
    if (result.status === "completed") {
      const descriptor = (await rpc("describe")) as ContractView;
      const id = "peer-refresh:" + randomUUID();
      new ContractStore(db).append(
        connection,
        viewCategories(descriptor).map((category) => ({
          sourceId: id + ":" + category,
          event: { category, type: "invalidated", resourceType: "scope" },
        })),
        id,
      );
    }
    return result;
  } finally {
    try {
      await rpc("close", { id: sub.id }, AbortSignal.timeout(2500));
    } catch {}
  }
}
