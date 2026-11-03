import { refreshPeerContract } from "./relay.ts";
import { describeContract, callContract, contractFailure } from "./engine.ts";
import { bindActivity, collectors, pushSources } from "./service.ts";
import { onConnectionChange } from "../connection-events.ts";
import { onAccessChange } from "../access-events.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { callerFrom, record } from "../audit.ts";
import { streamSSE } from "hono/streaming";
import { requireUser, type Env, assertConnectionAccess } from "../auth.ts";
import { db } from "../db.ts";
import { getConnectionRow, listConnections } from "../connections.ts";
import { websocketAccess } from "../websocket-access.ts";
import { HttpError, badRequest } from "../http.ts";
import { ContractStore } from "./store.ts";
import { CATEGORIES } from "./model.ts";
async function json(c: any) {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("invalid_json");
  }
}
function store() {
  return new ContractStore(db);
}
function checked(c: any, ref: string) {
  const row = getConnectionRow(c.get("user").id, ref);
  assertConnectionAccess(c, row.id);
  websocketAccess(c).check(row.id);
  return row;
}
function owned(c: any, id: string) {
  const s = store().subscription(c.get("user").id, id);
  const access = websocketAccess(c);
  for (const connection of s.connections) access.check(connection);
  return s;
}
export const contracts = new Hono<Env>();
contracts.use("*", requireUser);
contracts.use(
  "*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: { code: "body_too_large" } }, 413),
  }),
);
contracts.use("/connections/:ref/contracts/v1/call", async (c, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    record({
      userId: c.get("user").id,
      caller: callerFrom(c, "call"),
      method: "CONTRACT",
      url: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  }
});
contracts.onError((error, c) => {
  const failure = contractFailure(error);
  return c.json({ error: { code: failure.code } }, failure.status as any);
});
contracts.get("/contracts/v1/connections", async (c) => {
  const category = c.req.query("category");
  if (category && !CATEGORIES.includes(category as any))
    throw badRequest("Invalid category");
  const out = [];
  for (const row of listConnections(
    c.get("user").id,
    c.get("token")?.connectionIds,
  )) {
    try {
      const view = await describeContract(
        websocketAccess(c),
        row.id,
        c.req.raw.signal,
        callerFrom(c, "call"),
      );
      const operations = view.operations
        .filter((o) => !category || o.category === category)
        .map((o) => o.name);
      if (operations.length)
        out.push({
          id: row.id,
          name: row.name,
          version: 1,
          operations,
          changes: view.changes,
        });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return c.json({ connections: out });
});
contracts.get("/connections/:ref/contracts/v1", async (c) =>
  c.json(
    await describeContract(
      websocketAccess(c),
      c.req.param("ref"),
      c.req.raw.signal,
      callerFrom(c, "call"),
    ),
  ),
);
contracts.post("/connections/:ref/contracts/v1/call", async (c) => {
  const response = await callContract(
    websocketAccess(c),
    c.req.param("ref"),
    await json(c),
    c.req.raw.signal,
    callerFrom(c, "call"),
    collectors(),
  );
  return c.json(response.result, response.status);
});
contracts.post("/contracts/v1/subscriptions", async (c) => {
  const b = await json(c);
  if (!Array.isArray(b.connections) || !b.connections.length)
    throw badRequest("Connections required");
  const ids = b.connections.map((id: unknown) => {
    if (typeof id !== "string") throw badRequest("Invalid connection");
    return checked(c, id).id;
  });
  const sub = store().create(c.get("user").id, ids);
  bindActivity(c.get("user").id, sub.id, websocketAccess(c).principal);
  return c.json(sub, 201);
});
contracts.post("/contracts/v1/subscriptions/:id/activity", async (c) => {
  owned(c, c.req.param("id"));
  const b = await json(c);
  if (typeof b.active !== "boolean") throw badRequest("active must be boolean");
  bindActivity(
    c.get("user").id,
    c.req.param("id"),
    websocketAccess(c).principal,
  );
  store().activity(c.get("user").id, c.req.param("id"), b.active);
  if (b.active) await pushSources().tick();
  return c.json({ saved: true });
});
contracts.delete("/contracts/v1/subscriptions/:id", async (c) => {
  owned(c, c.req.param("id"));
  store().remove(c.get("user").id, c.req.param("id"));
  await pushSources().tick();
  return c.json({ deleted: true });
});
contracts.get("/contracts/v1/subscriptions/:id/status", (c) => {
  const sub = owned(c, c.req.param("id"));
  return c.json({
    activeUntil: sub.active_until,
    pollUntil: sub.poll_until,
    sources: sub.connections.map((connectionId: string) => ({
      connectionId,
      reconciliation: collectors().state(connectionId),
      native: pushSources().state(connectionId),
    })),
  });
});
contracts.get("/contracts/v1/subscriptions/:id/events", async (c) => {
  const id = c.req.param("id");
  owned(c, id);
  const access = websocketAccess(c);
  let cursor = Number(
    c.req.header("last-event-id") ?? c.req.query("cursor") ?? 0,
  );
  store().read(c.get("user").id, id, cursor);
  return streamSSE(c, async (stream) => {
    let abortWake = () => {};
    stream.onAbort(() => abortWake());
    while (!stream.aborted) {
      let done = () => {};
      let off = () => {};
      const waiting = new Promise<void>((resolve) => {
        done = resolve;
      });
      const timer = setTimeout(() => done(), 20000);
      const eventOff = store().onChange(() => done());
      const accessOff = onAccessChange(() => done());
      const connectionOff = onConnectionChange(() => done());
      off = () => {
        eventOff();
        accessOff();
        connectionOff();
      };
      abortWake = () => done();
      try {
        const s = store().subscription(c.get("user").id, id);
        for (const connection of s.connections) access.check(connection);
        const page = store().read(c.get("user").id, id, cursor);
        for (const event of page.events)
          await stream.writeSSE({
            id: event.id,
            event: "change",
            data: JSON.stringify(event),
          });
        cursor = page.cursor;
        if (!page.events.length)
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ cursor }),
          });
        if (!page.events.length) await waiting;
      } finally {
        clearTimeout(timer);
        off();
      }
    }
  });
});

contracts.post("/contracts/v1/subscriptions/:id/refresh", async (c) => {
  const sub = owned(c, c.req.param("id"));
  const input = await json(c);
  if (
    typeof input.connectionId !== "string" ||
    !sub.connections.includes(input.connectionId)
  )
    throw badRequest("Connection outside subscription");
  const row = checked(c, input.connectionId);
  const description = await describeContract(
    websocketAccess(c),
    row.id,
    c.req.raw.signal,
    callerFrom(c, "call"),
  );
  if (!description.changes.reconciliation)
    throw new HttpError(501, "collector_not_supported");
  bindActivity(c.get("user").id, sub.id, websocketAccess(c).principal);
  // Explicit refresh grants one short-lived read window; it never marks the UI as active.
  const previous = sub.poll_until,
    until = Math.max(previous, Date.now() + 30000);
  db.prepare(
    "UPDATE contract_subscriptions SET poll_until=MAX(poll_until,?) WHERE id=?",
  ).run(until, sub.id);
  try {
    const result = row.peer_id
      ? await refreshPeerContract(row.id, row, c.get("user"), c.req.raw.signal)
      : await collectors().refresh(input.connectionId, true);
    if (result.status === "auth_required")
      collectors().pauseAuthentication(row.id);
    return c.json(result);
  } finally {
    db.prepare(
      "UPDATE contract_subscriptions SET poll_until=? WHERE id=? AND poll_until=?",
    ).run(previous, sub.id, until);
  }
});
