import { calendarOperations } from "./calendar-schema.ts";
import { bindActivity, collectors } from "./service.ts";
import { onConnectionChange } from "../connection-events.ts";
import { onAccessChange } from "../access-events.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { callerFrom, record } from "../audit.ts";
import { streamSSE } from "hono/streaming";
import { Ajv } from "ajv";
import { requireUser, type Env, assertConnectionAccess } from "../auth.ts";
import { db } from "../db.ts";
import {
  getConnectionRow,
  listConnections,
  loadConnection,
} from "../connections.ts";
import { execute } from "../proxy.ts";
import { websocketAccess } from "../websocket-access.ts";
import { HttpError, badRequest } from "../http.ts";
import { ContractStore } from "./store.ts";
import { CATEGORIES } from "./model.ts";
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();
function validate(
  schema: Record<string, unknown>,
  value: unknown,
  output = false,
) {
  let f = validators.get(schema);
  if (!f) {
    f = ajv.compile(schema);
    validators.set(schema, f);
  }
  if (!f(value))
    throw new HttpError(
      output ? 502 : 400,
      output ? "invalid_contract_response" : "invalid_contract_arguments",
    );
}
function store() {
  return new ContractStore(db);
}
function checked(c: any, ref: string) {
  const row = getConnectionRow(c.get("user").id, ref);
  assertConnectionAccess(c, row.id);
  if (row.peer_id) throw new HttpError(501, "contract_peer_upgrade_required");
  return loadConnection(c.get("user").id, row.id);
}
function owned(c: any, id: string) {
  const s = store().subscription(c.get("user").id, id);
  const access = websocketAccess(c);
  for (const connection of s.connections) access.check(connection);
  return s;
}
export const contracts = new Hono<Env>();
contracts.use("*", requireUser);
contracts.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
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
  const codes: Record<string, number> = {
    subscription_not_found: 404,
    invalid_cursor: 409,
    idempotency_conflict: 409,
    invalid_subscription: 400,
    invalid_limit: 400,
    invalid_idempotency_key: 400,
    not_found: 404,
    conflict: 409,
    invalid_request: 400,
    permission_denied: 403,
    authentication_required: 409,
    rate_limited: 429,
  };
  const code =
    error instanceof HttpError
      ? error.message
      : ((error as any).code ?? error.message);
  const status =
    error instanceof HttpError ? error.status : (codes[code] ?? 500);
  return c.json(
    { error: { code: status === 500 ? "contract_failed" : code } },
    status as any,
  );
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
      const { conn, service } = checked(c, row.id);
      const definition = service.contracts;
      if (!definition) continue;
      const available = await definition.available(conn);
      const operations = available.filter(
        (name) =>
          definition.operations[name] &&
          (!category || definition.operations[name].category === category),
      );
      if (operations.length)
        out.push({ id: row.id, name: row.name, version: 1, operations });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return c.json({ connections: out });
});
contracts.get("/connections/:ref/contracts/v1", async (c) => {
  const { conn, service } = checked(c, c.req.param("ref"));
  const definition = service.contracts;
  if (!definition) throw new HttpError(501, "contract_not_supported");
  const names = await definition.available(conn);
  return c.json({
    version: 1,
    operations: names
      .filter((n) => definition.operations[n])
      .map((n) => {
        const o = definition.operations[n];
        return {
          name: n,
          category: o.category,
          readOnly: o.readOnly,
          inputSchema: calendarOperations[n]?.inputSchema ?? o.inputSchema,
          outputSchema: calendarOperations[n]?.outputSchema ?? o.outputSchema,
        };
      }),
  });
});
contracts.post("/connections/:ref/contracts/v1/call", async (c) => {
  const { conn, service } = checked(c, c.req.param("ref"));
  const definition = service.contracts;
  if (!definition) throw new HttpError(501, "contract_not_supported");
  const input = await c.req.json();
  if (!input || typeof input.operation !== "string")
    throw badRequest("Operation required");
  const op = Object.hasOwn(definition.operations, input.operation)
    ? definition.operations[input.operation]
    : undefined;
  if (!op || !(await definition.available(conn)).includes(input.operation))
    throw new HttpError(403, "operation_not_available");
  const args = input.arguments ?? {};
  const common = Object.hasOwn(calendarOperations, input.operation)
    ? calendarOperations[input.operation]
    : undefined;
  if (common) validate(common.inputSchema, args);
  validate(op.inputSchema, args);
  if (!op.readOnly) {
    if (collectors().state(conn.id).status === "auth_required")
      throw new HttpError(409, "authentication_required");
    if (typeof input.idempotencyKey !== "string")
      throw badRequest("Idempotency key required");
    const prior = store().intent(conn.id, input.idempotencyKey, {
      operation: input.operation,
      arguments: args,
    });
    if (prior) return c.json(prior);
  }
  try {
    let result = await op.invoke(args, {
      connection: conn,
      signal: c.req.raw.signal,
      request: async (request) => {
        websocketAccess(c).check(conn.id);
        return (
          await execute(c.get("user"), conn.id, request, c.req.raw.signal)
        ).response;
      },
    });
    if (common) validate(common.outputSchema, result, true);
    validate(op.outputSchema, result, true);
    if (!op.readOnly) {
      if (
        !result ||
        !["accepted", "rejected", "uncertain"].includes((result as any).status)
      )
        throw badRequest("Invalid write receipt");
      const receipt = result as Record<string, unknown>;
      result = Object.fromEntries(
        ["status", "resourceId", "version", "code"]
          .filter((key) => receipt[key] !== undefined)
          .map((key) => {
            if (
              typeof receipt[key] !== "string" ||
              (receipt[key] as string).length > 1024
            )
              throw badRequest("Invalid receipt field");
            return [key, receipt[key]];
          }),
      );
      store().receipt(conn.id, input.idempotencyKey, result);
    }
    return c.json(result as any);
  } catch (e: any) {
    if (
      [
        "auth_required",
        "authentication_required",
        "invalid_grant",
        "permission_denied",
      ].includes(e.code) ||
      e.status === 401 ||
      e.status === 403
    )
      collectors().pauseAuthentication(conn.id);
    if (!op.readOnly) return c.json({ status: "uncertain" }, 202);
    throw e;
  }
});
contracts.post("/contracts/v1/subscriptions", async (c) => {
  const b = await c.req.json();
  if (!Array.isArray(b.connections) || !b.connections.length)
    throw badRequest("Connections required");
  const ids = b.connections.map((id: unknown) => {
    if (typeof id !== "string") throw badRequest("Invalid connection");
    return checked(c, id).conn.id;
  });
  const sub = store().create(c.get("user").id, ids);
  bindActivity(c.get("user").id, sub.id, websocketAccess(c).principal);
  return c.json(sub, 201);
});
contracts.post("/contracts/v1/subscriptions/:id/activity", async (c) => {
  owned(c, c.req.param("id"));
  const b = await c.req.json();
  if (typeof b.active !== "boolean") throw badRequest("active must be boolean");
  bindActivity(
    c.get("user").id,
    c.req.param("id"),
    websocketAccess(c).principal,
  );
  store().activity(c.get("user").id, c.req.param("id"), b.active);
  return c.json({ saved: true });
});
contracts.delete("/contracts/v1/subscriptions/:id", (c) => {
  owned(c, c.req.param("id"));
  store().remove(c.get("user").id, c.req.param("id"));
  return c.json({ deleted: true });
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
  const input = await c.req.json();
  if (
    typeof input.connectionId !== "string" ||
    !sub.connections.includes(input.connectionId)
  )
    throw badRequest("Connection outside subscription");
  const { service } = checked(c, input.connectionId);
  if (!service.contracts?.collect)
    throw new HttpError(501, "collector_not_supported");
  bindActivity(c.get("user").id, sub.id, websocketAccess(c).principal);
  // Explicit refresh grants one short-lived read window; it never marks the UI as active.
  const previous = sub.poll_until,
    until = Math.max(previous, Date.now() + 30000);
  db.prepare(
    "UPDATE contract_subscriptions SET poll_until=MAX(poll_until,?) WHERE id=?",
  ).run(until, sub.id);
  try {
    return c.json(await collectors().refresh(input.connectionId, true));
  } finally {
    db.prepare(
      "UPDATE contract_subscriptions SET poll_until=? WHERE id=? AND poll_until=?",
    ).run(previous, sub.id, until);
  }
});
