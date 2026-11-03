import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-api-"));
process.env.SWITCHBOARD_DATA_DIR = temp;
const database = await import("../server/db.ts");
database.initDb();
const { db, run } = database;
const { initKey, encrypt } = await import("../server/crypto.ts");
initKey();
const { createUser, createToken } = await import("../server/users.ts");
const { plugins } = await import("../server/plugins/manager.ts");
const { contracts } = await import("../server/contracts/routes.ts");
const user = createUser("fixture", "admin"),
  other = createUser("other", "user");
let writes = 0,
  reads = 0;
plugins.services.set("fixture", {
  pluginId: "fixture",
  service: {
    id: "fixture",
    name: "Fixture",
    authMethods: [
      { id: "fixture", label: "Fixture", authorize: async () => {} } as any,
    ],
    contracts: {
      version: 1,
      available: () => ["messaging.messages.send", "messaging.messages.list"],
      collect: async () => {
        reads++;
        return {
          events: [
            {
              sourceId: String(reads),
              event: {
                category: "messaging",
                type: "invalidated",
                resourceType: "messages",
              },
            },
          ],
          checkpoint: String(reads),
        };
      },
      operations: {
        "messaging.messages.list": {
          category: "messaging",
          readOnly: true,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          invoke: async (input) => {
            if (input.conversationId === "denied")
              throw Object.assign(Error("Resource denied"), {
                code: "permission_denied",
                status: 403,
              });
            return { items: [], coverage: { complete: true } };
          },
        },
        "messaging.messages.send": {
          category: "messaging",
          readOnly: false,
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string" },
              conversationId: { type: "string" },
            },
            additionalProperties: false,
          },
          outputSchema: { type: "object" },
          invoke: async () => {
            writes++;
            return {
              status: "accepted",
              resourceId: "m",
              text: "private message content",
            };
          },
        },
      },
    },
  },
});
plugins.services.set("calendar-fixture", {
  pluginId: "fixture",
  service: {
    id: "calendar-fixture",
    name: "Calendar fixture",
    authMethods: [
      { id: "fixture", label: "Fixture", authorize: async () => {} } as any,
    ],
    contracts: {
      version: 1,
      available: () => ["calendar.events.list"],
      operations: {
        "calendar.events.list": {
          category: "calendar",
          readOnly: true,
          inputSchema: {},
          outputSchema: {},
          invoke: async () => ({
            items: [{ id: "incomplete" }],
            coverage: { complete: true },
          }),
        },
      },
    },
  },
});
run(
  "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  "calendar",
  user.id,
  "calendar-fixture",
  "fixture",
  "calendar",
  encrypt({}),
  encrypt({}),
  "ok",
  Date.now(),
  Date.now(),
);
let authAttempts = 0;
plugins.services.set("expired-auth", {
  pluginId: "fixture",
  service: {
    id: "expired-auth",
    name: "Expired auth",
    baseUrl: "https://fixture.invalid",
    authMethods: [
      {
        id: "fixture",
        name: "Fixture",
        async connect() {
          return { credentials: {} };
        },
        async authorize() {
          authAttempts++;
          throw Object.assign(Error("private provider details"), {
            reauthenticationRequired: true,
          });
        },
      },
    ],
    contracts: {
      version: 1,
      available: () => ["messaging.messages.list"],
      operations: {
        "messaging.messages.list": {
          category: "messaging",
          readOnly: true,
          inputSchema: {},
          outputSchema: {},
          invoke: async () => ({ items: [], coverage: { complete: true } }),
        },
      },
      async collect(_input, ctx) {
        await ctx.request({
          method: "GET",
          url: "https://fixture.invalid/messages",
        });
        return { events: [], checkpoint: "unused" };
      },
    },
  },
});
run(
  "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  "expired",
  user.id,
  "expired-auth",
  "fixture",
  "expired",
  encrypt({}),
  encrypt({}),
  "ok",
  Date.now(),
  Date.now(),
);
for (const id of ["first", "second"])
  run(
    "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    user.id,
    "fixture",
    "fixture",
    id,
    encrypt({}),
    encrypt({}),
    "ok",
    Date.now(),
    Date.now(),
  );
const token = createToken(user.id, "limited", ["first"]).secret,
  foreign = createToken(other.id, "other", null).secret;
async function call(url: string, body?: unknown, auth = token) {
  return contracts.request("http://localhost" + url, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + auth,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test("scoped discovery and execution never expose another connection", async () => {
  const r = await call("/contracts/v1/connections?category=messaging");
  assert.equal(r.status, 200);
  assert.deepEqual(
    ((await r.json()) as any).connections.map((c: any) => c.id),
    ["first"],
  );
  assert.equal((await call("/connections/second/contracts/v1")).status, 403);
});
test("writes validate and replay without sending twice", async () => {
  const input = {
    operation: "messaging.messages.send",
    arguments: { text: "fixture", conversationId: "chat" },
    idempotencyKey: "key",
  };
  for (let n = 0; n < 2; n++) {
    const r = await call("/connections/first/contracts/v1/call", input);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "accepted", resourceId: "m" });
  }
  assert.equal(writes, 1);
  assert.equal(
    (
      await call("/connections/first/contracts/v1/call", {
        ...input,
        arguments: {},
      })
    ).status,
    400,
  );
});
test("subscriptions are owner and scope bound", async () => {
  assert.equal(
    (await call("/contracts/v1/subscriptions", { connections: ["second"] }))
      .status,
    403,
  );
  const r = await call("/contracts/v1/subscriptions", {
    connections: ["first"],
  });
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as any;
  assert.equal(
    (
      await call("/contracts/v1/subscriptions/" + id + "/activity", {
        active: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/contracts/v1/subscriptions/" + id + "/activity",
        { active: true },
        foreign,
      )
    ).status,
    404,
  );
});
test("manual refresh authorizes a single idle read and applies cooldown", async () => {
  const r = await call("/contracts/v1/subscriptions", {
    connections: ["first"],
  });
  const { id } = (await r.json()) as any;
  const refresh = () =>
    call("/contracts/v1/subscriptions/" + id + "/refresh", {
      connectionId: "first",
    });
  assert.equal(((await (await refresh()).json()) as any).status, "completed");
  assert.equal(reads, 1);
  assert.equal(((await (await refresh()).json()) as any).status, "deferred");
  assert.equal(reads, 1);
  assert.equal(
    (
      await call("/contracts/v1/subscriptions/" + id + "/refresh", {
        connectionId: "second",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      db
        .prepare("SELECT poll_until FROM contract_subscriptions WHERE id=?")
        .get(id) as any
    ).poll_until,
    0,
  );
});
test("authentication pause blocks new writes before dispatch", async () => {
  const { collectors } = await import("../server/contracts/service.ts");
  collectors().pauseAuthentication("first");
  const before = writes;
  assert.equal(
    (
      await call("/connections/first/contracts/v1/call", {
        operation: "messaging.messages.send",
        arguments: { text: "fixture", conversationId: "chat" },
        idempotencyKey: "blocked",
      })
    ).status,
    409,
  );
  assert.equal(writes, before);
  assert.equal(
    db.prepare("SELECT * FROM contract_receipts WHERE key='blocked'").get(),
    undefined,
  );
  collectors().credentialsChanged("first");
});
test("SSE replays committed events and invalid cursors require resync", async () => {
  const r = await call("/contracts/v1/subscriptions", {
    connections: ["first"],
  });
  const { id } = (await r.json()) as any;
  assert.equal(
    (await call("/contracts/v1/subscriptions/" + id + "/events?cursor=999999"))
      .status,
    409,
  );
  const response = await call(
    "/contracts/v1/subscriptions/" + id + "/events?cursor=0",
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const reader = response.body!.getReader();
  try {
    const first = await reader.read();
    const data = new TextDecoder().decode(first.value);
    assert.match(data, /event: change/);
    assert.match(data, /messaging/);
  } finally {
    await reader.cancel();
  }
});
test("contract audit records omit content and receipts omit provider extensions", () => {
  const logs = db
    .prepare("SELECT * FROM audit_log WHERE method='CONTRACT'")
    .all();
  assert.ok(logs.length);
  assert.ok(!JSON.stringify(logs).includes("private message content"));
  assert.ok(logs.every((r: any) => r.request_body === null));
  assert.ok(
    !JSON.stringify(
      db.prepare("SELECT * FROM contract_receipts").all(),
    ).includes("private message content"),
  );
});
test("common calendar schemas are enforced even when adapter schemas are permissive", async () => {
  const broad = createToken(user.id, "calendar", ["calendar"]).secret;
  const descriptor = (await (
    await call("/connections/calendar/contracts/v1", undefined, broad)
  ).json()) as any;
  assert.ok(
    descriptor.operations[0].inputSchema.required.includes("calendarId"),
  );
  assert.equal(
    (
      await call(
        "/connections/calendar/contracts/v1/call",
        { operation: "calendar.events.list", arguments: {} },
        broad,
      )
    ).status,
    400,
  );
  // Valid input, but the adapter attempts to return a nonconforming event.
  assert.equal(
    (
      await call(
        "/connections/calendar/contracts/v1/call",
        {
          operation: "calendar.events.list",
          arguments: {
            calendarId: "c",
            timeMin: "2026-01-01T00:00:00Z",
            timeMax: "2027-01-01T00:00:00Z",
          },
        },
        broad,
      )
    ).status,
    502,
  );
});
test("terminal token renewal failures survive proxy wrapping and stop subsequent refreshes", async () => {
  const scoped = createToken(user.id, "expired", ["expired"]).secret;
  const { id } = (await (
    await call(
      "/contracts/v1/subscriptions",
      { connections: ["expired"] },
      scoped,
    )
  ).json()) as any;
  const refresh = () =>
    call(
      "/contracts/v1/subscriptions/" + id + "/refresh",
      { connectionId: "expired" },
      scoped,
    );
  const first = await refresh();
  assert.equal(((await first.json()) as any).status, "auth_required");
  assert.equal(
    ((await (await refresh()).json()) as any).status,
    "auth_required",
  );
  assert.equal(authAttempts, 1);
  const status = (await (
    await call(
      "/contracts/v1/subscriptions/" + id + "/status",
      undefined,
      scoped,
    )
  ).json()) as any;
  assert.equal(status.sources[0].reconciliation.status, "auth_required");

  const { collectors } = await import("../server/contracts/service.ts");
  assert.equal(collectors().state("expired").error, "authentication_required");
});
test("native publication reaches the same resumable SSE API and stops on unsubscribe", async () => {
  let publish!: (batch: any) => Promise<void>,
    stopped = false;
  plugins.services.set("native-fixture", {
    pluginId: "fixture",
    service: {
      id: "native-fixture",
      name: "Native fixture",
      authMethods: [
        {
          id: "fixture",
          name: "Fixture",
          connect: async () => ({ credentials: {} }),
          authorize: async () => {},
        },
      ],
      contracts: {
        version: 1,
        available: () => ["messaging.messages.list"],
        operations: {
          "messaging.messages.list": {
            category: "messaging",
            readOnly: true,
            inputSchema: {},
            outputSchema: {},
            invoke: async () => ({ items: [], coverage: { complete: true } }),
          },
        },
        async watch(_input, ctx) {
          publish = ctx.publish;
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener(
              "abort",
              () => {
                stopped = true;
                resolve();
              },
              { once: true },
            ),
          );
        },
      },
    },
  });
  run(
    "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    "native",
    user.id,
    "native-fixture",
    "fixture",
    "native",
    encrypt({}),
    encrypt({}),
    "ok",
    Date.now(),
    Date.now(),
  );
  const scoped = createToken(user.id, "native", ["native"]).secret;
  const descriptor = (await (
    await call("/connections/native/contracts/v1", undefined, scoped)
  ).json()) as any;
  assert.deepEqual(descriptor.changes, { native: true, reconciliation: false });
  const { id, cursor } = (await (
    await call(
      "/contracts/v1/subscriptions",
      { connections: ["native"] },
      scoped,
    )
  ).json()) as any;
  await call(
    "/contracts/v1/subscriptions/" + id + "/activity",
    { active: true },
    scoped,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof publish, "function");
  await publish({
    events: [
      {
        sourceId: "native-delivery",
        event: {
          category: "messaging",
          type: "created",
          resourceType: "message",
          resourceId: "native-message",
          debugText: "never persist this body",
        },
      },
    ],
    checkpoint: "native-cursor",
  });
  const response = await call(
    "/contracts/v1/subscriptions/" + id + "/events?cursor=" + cursor,
    undefined,
    scoped,
  );
  const reader = response.body!.getReader();
  try {
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /native-message/);
    assert.ok(!text.includes("never persist"));
  } finally {
    await reader.cancel();
  }
  const deleted = await contracts.request(
    "http://localhost/contracts/v1/subscriptions/" + id,
    { method: "DELETE", headers: { authorization: "Bearer " + scoped } },
  );
  assert.equal(deleted.status, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
});
test("contract input body limits and malformed JSON return client errors", async () => {
  const huge = await call("/connections/first/contracts/v1/call", {
    operation: "messaging.messages.send",
    arguments: { text: "a".repeat(1024 * 1024) },
  });
  assert.equal(huge.status, 413);
  const invalid = await contracts.request(
    "http://localhost/connections/first/contracts/v1/call",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: "{broken",
    },
  );
  assert.equal(invalid.status, 400);
});
test("a forbidden resource does not pause other reads on the connection", async () => {
  const denied = await call("/connections/first/contracts/v1/call", {
    operation: "messaging.messages.list",
    arguments: { conversationId: "denied" },
  });
  assert.equal(denied.status, 403);
  const { collectors } = await import("../server/contracts/service.ts");
  assert.notEqual(collectors().state("first").status, "auth_required");
  assert.equal(
    (
      await call("/connections/first/contracts/v1/call", {
        operation: "messaging.messages.list",
        arguments: { conversationId: "allowed" },
      })
    ).status,
    200,
  );
});
after(async () => {
  const { pushSources, collectors } = await import(
    "../server/contracts/service.ts"
  );
  await Promise.all([pushSources().stop(), collectors().stop()]);
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
