import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "contract-peers-")),
  children: ChildProcess[] = [];
let key = "fixture-secret",
  seq = 0,
  polls = 0;
const sent: any[] = [],
  events: any[] = [],
  waiting = new Set<() => void>();
const upstream = http.createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer " + key) {
    res.writeHead(401).end("{}");
    return;
  }
  const url = new URL(req.url!, "http://fixture");
  const reply = (data: any) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };
  if (url.pathname === "/snapshot")
    return reply({
      items: [{ id: "chat", title: "Fixture", kind: "group", unread: null }],
      coverage: { complete: true },
    });
  if (url.pathname === "/messages")
    return reply({
      items: [
        {
          id: "m",
          conversationId: "chat",
          text: "PRIVATE-READ-BODY",
          authorId: "other",
          createdAt: null,
          isOwn: false,
          contentState: "available",
          contentType: "text",
        },
      ],
      coverage: { complete: true },
    });
  if (url.pathname === "/poll") {
    polls++;
    return reply({ ok: true });
  }
  if (url.pathname === "/send") {
    let body = "";
    for await (const chunk of req) body += chunk;
    sent.push(JSON.parse(body));
    if (sent.at(-1).text === "ambiguous-dispatch") return res.destroy();
    return reply({ status: "accepted", resourceId: "sent-" + sent.length });
  }
  if (url.pathname === "/events") {
    const after = Number(url.searchParams.get("after"));
    let timer: ReturnType<typeof setTimeout>;
    const flush = () => {
      clearTimeout(timer);
      waiting.delete(flush);
      reply({ cursor: seq, events: events.filter((e) => e.seq > after) });
    };
    if (events.some((e) => e.seq > after)) return flush();
    waiting.add(flush);
    timer = setTimeout(flush, 20000);
    res.on("close", () => {
      clearTimeout(timer);
      waiting.delete(flush);
    });
    return;
  }
  res.writeHead(404).end("{}");
});
upstream.listen(0, "127.0.0.1");
function emit(id: string) {
  events.push({ seq: ++seq, id });
  for (const fn of [...waiting]) fn();
}
after(async () => {
  for (const child of children) child.kill();
  upstream.closeAllConnections();
  upstream.close();
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(scratch, { recursive: true, force: true });
});
async function until(fn: () => any | Promise<any>, description = "condition") {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Timed out: " + description);
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function launch(name: string, enabled = true) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.cpSync(
    path.join(import.meta.dirname, "fixtures/contracts-plugin"),
    path.join(dir, "plugins/contracts-test"),
    { recursive: true },
  );
  const port = await freePort(),
    url = "http://127.0.0.1:" + port;
  let output = "",
    cookie = "";
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "server/main.ts"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        SWITCHBOARD_DATA_DIR: dir,
        SWITCHBOARD_PORT: String(port),
        SWITCHBOARD_HOST: "127.0.0.1",
        SWITCHBOARD_PUBLIC_URL: url,
        SWITCHBOARD_WATCH_PLUGINS: "false",
        SWITCHBOARD_SHARED_CONTRACTS: enabled ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  child.stdout!.on("data", (b) => (output += b));
  child.stderr!.on("data", (b) => (output += b));
  await until(() => output.includes("Switchboard listening"), "launch " + name);
  const request = async (
    method: string,
    route: string,
    body?: unknown,
    token?: string,
  ) => {
    const response = await fetch(url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        ...(token ? { authorization: "Bearer " + token } : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data: (await response.json()) as any };
  };
  const invite = output.match(/\/invite#(\S+)/)?.[1];
  assert.ok(invite, output);
  assert.equal(
    (
      await request("POST", "/api/auth/invite", {
        token: invite,
        password: "fixture-password",
      })
    ).status,
    200,
  );
  const user = (await request("GET", "/api/me")).data;
  return {
    dir,
    url,
    request,
    user,
    child,
    get cookie() {
      return cookie;
    },
    get output() {
      return output;
    },
  };
}
async function pair(receiver: any, sender: any) {
  const incoming = await receiver.request("POST", "/api/admin/peers", {
    name: "From " + sender.user.id,
    ownerUserId: receiver.user.id,
  });
  assert.equal(incoming.status, 201);
  const outgoing = await sender.request("POST", "/api/admin/peers", {
    direction: "outgoing",
    name: "To " + receiver.user.id,
    url: receiver.url,
    token: incoming.data.token,
    ownerUserId: sender.user.id,
  });
  assert.equal(outgoing.status, 201);
  await until(async () =>
    (await receiver.request("GET", "/api/admin/peers")).data.some(
      (p: any) => p.id === incoming.data.peer.id && p.online,
    ),
  );
  return { incoming: incoming.data.peer.id, outgoing: outgoing.data.peer.id };
}
function sql(instance: any, fn: (db: DatabaseSync) => any) {
  const db = new DatabaseSync(path.join(instance.dir, "switchboard.db"));
  db.exec("PRAGMA busy_timeout=5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function change(instance: any, subscription: string, cursor: number) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 12000);
  const response = await fetch(
    instance.url +
      "/api/contracts/v1/subscriptions/" +
      subscription +
      "/events?cursor=" +
      cursor,
    { headers: { cookie: instance.cookie }, signal: abort.signal },
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      buffer += new TextDecoder().decode(chunk.value);
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.includes("event: change"))
          return JSON.parse(
            frame
              .split("\n")
              .find((l) => l.startsWith("data: "))!
              .slice(6),
          );
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
    await reader.cancel().catch(() => {});
  }
}

test("shared contracts and durable changes traverse multiple protocol-3 peers without sharing credentials", async () => {
  await until(() => upstream.address());
  const origin = await launch("origin"),
    middle = await launch("middle"),
    gateway = await launch("gateway");
  const first = await pair(middle, origin),
    second = await pair(gateway, middle);
  const endpoint =
    "http://127.0.0.1:" + (upstream.address() as AddressInfo).port + "/";
  const connected = await origin.request("POST", "/api/connections", {
    service: "contracts-test",
    method: "key",
    name: "shared-contract",
    config: { endpoint, key },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  const originId = connected.data.connection.id;
  await origin.request("PUT", `/api/connections/${originId}/shares`, {
    peerIds: [first.outgoing],
  });
  let mid: any, local: any;
  await until(async () => {
    mid = (await middle.request("GET", "/api/connections")).data.find(
      (c: any) => c.name === "shared-contract",
    );
    return mid;
  });
  await middle.request("PUT", `/api/connections/${mid.id}/shares`, {
    peerIds: [second.outgoing],
  });
  await until(async () => {
    local = (await gateway.request("GET", "/api/connections")).data.find(
      (c: any) => c.name === "shared-contract",
    );
    return local;
  });
  const root = `/api/connections/${local.id}/contracts/v1`;
  const description = await gateway.request("GET", root);
  assert.equal(description.status, 200, JSON.stringify(description.data));
  assert.equal(description.data.version, 1);
  assert.equal(description.data.changes.native, true);
  const discovery = await gateway.request(
    "GET",
    "/api/contracts/v1/connections?category=messaging",
  );
  assert.ok(discovery.data.connections.some((c: any) => c.id === local.id));
  const read = await gateway.request("POST", root + "/call", {
    operation: "messaging.messages.list",
    arguments: { conversationId: "chat" },
  });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.items[0].text, "PRIVATE-READ-BODY");
  const input = {
    operation: "messaging.messages.send",
    arguments: { conversationId: "chat", text: "PRIVATE-SEND-BODY" },
    idempotencyKey: "same-request",
  };
  for (let n = 0; n < 2; n++) {
    const sent = await gateway.request("POST", root + "/call", input);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.status, "accepted");
  }
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].key, input.idempotencyKey);
  const ambiguous = {
    operation: "messaging.messages.send",
    arguments: { conversationId: "chat", text: "ambiguous-dispatch" },
    idempotencyKey: "ambiguous-request",
  };
  const uncertain = await gateway.request("POST", root + "/call", ambiguous);
  assert.equal(uncertain.status, 202);
  assert.equal(uncertain.data.status, "uncertain");
  const retry = await gateway.request("POST", root + "/call", ambiguous);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.status, "uncertain");
  assert.equal(
    sent.length,
    2,
    "an ambiguous provider dispatch must never resend across peers",
  );
  const sub = (
    await gateway.request("POST", "/api/contracts/v1/subscriptions", {
      connections: [local.id],
    })
  ).data;
  const active = await gateway.request(
    "POST",
    `/api/contracts/v1/subscriptions/${sub.id}/activity`,
    { active: true },
  );
  assert.equal(active.status, 200, JSON.stringify(active.data));
  await until(() => waiting.size > 0, "upstream native receive");
  emit("new-message");
  await until(
    () =>
      sql(
        gateway,
        (db) =>
          (
            db
              .prepare(
                "SELECT count(*) n FROM contract_events WHERE json_extract(event,'$.resourceId')='new-message'",
              )
              .get() as any
          ).n > 0,
      ),
    "durable relay",
  );
  const page = await change(gateway, sub.id, sub.cursor);
  assert.equal(page.connectionId, local.id);
  assert.equal(page.category, "messaging");
  const stored = sql(
    gateway,
    (db) =>
      db
        .prepare(
          "SELECT seq FROM contract_events WHERE json_extract(event,'$.resourceId')='new-message'",
        )
        .get() as any,
  );
  const replay = await change(gateway, sub.id, stored.seq - 1);
  assert.equal(replay.resourceId, "new-message");
  for (const instance of [middle, gateway])
    for (const suffix of ["", "-wal"]) {
      const file = path.join(instance.dir, "switchboard.db" + suffix);
      if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.includes(Buffer.from(key)), false);
        assert.equal(bytes.includes(Buffer.from("PRIVATE-READ-BODY")), false);
        assert.equal(bytes.includes(Buffer.from("PRIVATE-SEND-BODY")), false);
      }
    }
  const other = await gateway.request("POST", "/api/connections", {
    service: "contracts-test",
    method: "key",
    name: "only-local",
    config: { endpoint, key: "local-fixture-key" },
  });
  assert.equal(other.status, 200);
  const scope = (
    await gateway.request("POST", "/api/tokens", {
      name: "restricted",
      connectionIds: [other.data.connection.id],
    })
  ).data.secret;
  assert.equal(
    (await gateway.request("GET", root, undefined, scope)).status,
    403,
  );
  // A transport interruption keeps the durable cursor and does not resend writes.
  assert.equal(
    (
      await gateway.request("PATCH", "/api/admin/peers/" + second.incoming, {
        disabled: true,
      })
    ).status,
    200,
  );
  emit("during-offline");
  await until(
    () =>
      sql(
        middle,
        (db) =>
          (
            db
              .prepare(
                "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.resourceId')='during-offline'",
              )
              .get() as any
          ).n > 0,
      ),
    "owner queued offline change",
  );
  await gateway.request("PATCH", "/api/admin/peers/" + second.incoming, {
    disabled: false,
  });
  await until(async () => {
    const d = await gateway.request("GET", root);
    if (d.status !== 200) return false;
    await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/activity`,
      { active: true },
    );
    return sql(
      gateway,
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.resourceId')='during-offline'",
            )
            .get() as any
        ).n === 1,
    );
  }, "replay after reconnect");
  assert.equal(sent.length, 2);
  const beforeResync = sql(
    gateway,
    (db) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.type')='resync.required'",
          )
          .get() as any
      ).n,
  );
  await gateway.request("PATCH", "/api/admin/peers/" + second.incoming, {
    disabled: true,
  });
  emit("evicted-change");
  await until(() =>
    sql(
      middle,
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.resourceId')='evicted-change'",
            )
            .get() as any
        ).n > 0,
    ),
  );
  sql(middle, (db) => {
    const head = (
      db.prepare("SELECT MAX(seq) n FROM contract_events").get() as any
    ).n;
    db.prepare("UPDATE contract_retention SET through_seq=?").run(head);
    db.prepare("DELETE FROM contract_events WHERE seq<=?").run(head);
  });
  await gateway.request("PATCH", "/api/admin/peers/" + second.incoming, {
    disabled: false,
  });
  await until(async () => {
    if ((await gateway.request("GET", root)).status !== 200) return false;
    await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/activity`,
      { active: true },
    );
    return (
      sql(
        gateway,
        (db) =>
          (
            db
              .prepare(
                "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.type')='resync.required'",
              )
              .get() as any
          ).n,
      ) > beforeResync
    );
  }, "explicit resync after remote eviction");
  await origin.request("PUT", `/api/connections/${originId}/shares`, {
    peerIds: [],
  });
  await until(
    async () => (await gateway.request("GET", root)).status === 403,
    "sharing revocation",
  );
  await until(() => waiting.size === 0, "owner receiver stopped");
  await origin.request("PUT", `/api/connections/${originId}/shares`, {
    peerIds: [first.outgoing],
  });
  await until(async () => {
    if ((await gateway.request("GET", root)).status !== 200) return false;
    await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/activity`,
      { active: true },
    );
    return waiting.size > 0;
  }, "restored sharing");
  key = "fixture-refreshed-secret";
  emit("auth-transition");
  await until(async () => {
    await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/activity`,
      { active: true },
    );
    return sql(gateway, (db) => {
      const row = db
        .prepare("SELECT state FROM contract_collectors WHERE connection=?")
        .get(local.id) as any;
      return row && JSON.parse(row.state).status === "auth_required";
    });
  }, "propagated auth pause");
  const pollCount = polls;
  for (let n = 0; n < 2; n++) {
    const refresh = await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/refresh`,
      { connectionId: local.id },
    );
    assert.equal(refresh.status, 200, JSON.stringify(refresh.data));
    assert.equal(refresh.data.status, "auth_required");
  }
  assert.equal(polls, pollCount);
  const revision = () =>
    sql(
      origin,
      (db) =>
        (
          db
            .prepare(
              "SELECT revision FROM contract_auth_versions WHERE connection=?",
            )
            .get(originId) as any
        ).revision,
    );
  const beforeSameCredentials = revision();
  const unchanged = await origin.request(
    "POST",
    `/api/connections/${originId}/reconnect`,
    { config: { endpoint, key: "fixture-secret" } },
  );
  assert.equal(unchanged.status, 200);
  assert.equal(
    revision(),
    beforeSameCredentials,
    "unchanged credentials must not advertise recovery",
  );
  assert.equal(
    sql(
      origin,
      (db) =>
        JSON.parse(
          (
            db
              .prepare(
                "SELECT state FROM contract_collectors WHERE connection=?",
              )
              .get(originId) as any
          ).state,
        ).status,
    ),
    "auth_required",
  );
  const reauth = await origin.request(
    "POST",
    `/api/connections/${originId}/reconnect`,
    { config: { endpoint, key } },
  );
  assert.equal(reauth.status, 200, JSON.stringify(reauth.data));
  await until(async () => {
    await gateway.request(
      "POST",
      `/api/contracts/v1/subscriptions/${sub.id}/activity`,
      { active: true },
    );
    return (
      waiting.size > 0 &&
      sql(gateway, (db) => {
        const row = db
          .prepare("SELECT state FROM contract_collectors WHERE connection=?")
          .get(local.id) as any;
        return row && JSON.parse(row.state).status !== "auth_required";
      })
    );
  }, "actual owner credential change resumes relay");
  emit("after-reauth");
  await until(() =>
    sql(
      gateway,
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) n FROM contract_events WHERE json_extract(event,'$.resourceId')='after-reauth'",
            )
            .get() as any
        ).n > 0,
    ),
  );
  assert.equal(
    (
      await gateway.request(
        "DELETE",
        `/api/contracts/v1/subscriptions/${sub.id}`,
      )
    ).status,
    200,
  );
  await until(() => waiting.size === 0, "native receive cleanup");
  // A passive relay may carry only the client's remaining lease, never a fresh grace period.
  const passive = (
    await gateway.request("POST", "/api/contracts/v1/subscriptions", {
      connections: [local.id],
    })
  ).data;
  const deadline = Date.now() + 1800;
  sql(gateway, (db) =>
    db
      .prepare(
        "UPDATE contract_subscriptions SET active_until=0,poll_until=? WHERE id=?",
      )
      .run(deadline, passive.id),
  );
  const tick = async () => {
    const inert = (
      await gateway.request("POST", "/api/contracts/v1/subscriptions", {
        connections: [local.id],
      })
    ).data;
    await gateway.request(
      "DELETE",
      `/api/contracts/v1/subscriptions/${inert.id}`,
    );
  };
  await tick();
  await until(() => waiting.size > 0, "passive relay started");
  for (const instance of [origin, middle]) {
    const lease = sql(instance, (db) =>
      db
        .prepare("SELECT MAX(poll_until) expiry FROM contract_subscriptions")
        .get(),
    ) as any;
    assert.ok(
      lease.expiry <= deadline + 150,
      "relay must not extend the client deadline",
    );
  }
  const beforeIdle = polls;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deadline - Date.now()) + 100),
  );
  emit("after-idle");
  await tick();
  await until(
    () => waiting.size === 0,
    "expired lease stops native receive despite connected peers",
  );
  assert.equal(polls, beforeIdle);
  await gateway.request(
    "DELETE",
    `/api/contracts/v1/subscriptions/${passive.id}`,
  );
});

test("protocol-3 peers without the contracts feature preserve classic calls and reject contract RPC", async () => {
  const owner = await launch("classic-owner", false),
    client = await launch("classic-client");
  const link = await pair(client, owner);
  const connected = await owner.request("POST", "/api/connections", {
    service: "contracts-test",
    method: "key",
    name: "classic",
    config: {
      endpoint:
        "http://127.0.0.1:" + (upstream.address() as AddressInfo).port + "/",
      key,
    },
  });
  assert.equal(connected.status, 200);
  await owner.request(
    "PUT",
    `/api/connections/${connected.data.connection.id}/shares`,
    { peerIds: [link.outgoing] },
  );
  let local: any;
  await until(async () => {
    local = (await client.request("GET", "/api/connections")).data.find(
      (c: any) => c.name === "classic",
    );
    return local;
  });
  const ordinary = await client.request("POST", "/api/call", {
    connection: local.id,
    url: "/snapshot",
  });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data));
  const unsupported = await client.request(
    "GET",
    `/api/connections/${local.id}/contracts/v1`,
  );
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.data.error.code, "contract_peer_upgrade_required");
});
