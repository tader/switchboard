import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import {
  ContractStore,
  CONTRACT_SCHEMA,
  IDLE_GRACE,
  ACTIVITY_LEASE,
} from "../server/contracts/store.ts";
import {
  ContractCollectors,
  CONTRACT_RUNTIME_SCHEMA,
} from "../server/contracts/runtime.ts";
import {
  ContractPushSources,
  CONTRACT_PUSH_SCHEMA,
} from "../server/contracts/push.ts";
import type { PushSource } from "../server/contracts/push.ts";
import type { ContractChangeBatch } from "../server/plugins/api.ts";
function fixture() {
  let now = 1_000_000,
    calls = 0,
    aborts = 0;
  const db = new DatabaseSync(":memory:");
  db.exec(CONTRACT_SCHEMA + CONTRACT_RUNTIME_SCHEMA + CONTRACT_PUSH_SCHEMA);
  const store = new ContractStore(db, () => now);
  const sub = store.create("u", ["c"]);
  let publish!: (batch: ContractChangeBatch) => Promise<void>;
  const checkpoints: (string | undefined)[] = [];
  const auth = new ContractCollectors(
    store,
    () => ({
      check() {},
      async collect() {
        throw Error("not used");
      },
    }),
    () => now,
  );
  const source: PushSource = {
    check() {},
    watch(checkpoint, emit, signal) {
      calls++;
      checkpoints.push(checkpoint);
      publish = emit;
      return new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborts++;
            resolve();
          },
          { once: true },
        ),
      );
    },
  };
  const create = (resolve: (id: string) => PushSource = () => source) =>
    new ContractPushSources(store, resolve, auth, () => now);
  return {
    db,
    store,
    sub,
    auth,
    source,
    create,
    advance: (n: number) => (now += n),
    calls: () => calls,
    aborts: () => aborts,
    publish: (batch: ContractChangeBatch) => publish(batch),
    checkpoints,
  };
}
const batch = (
  checkpoint: string,
  sourceId = checkpoint,
): ContractChangeBatch => ({
  events: [
    {
      sourceId,
      event: {
        category: "messaging",
        type: "created",
        resourceType: "message",
        resourceId: sourceId,
      },
    },
  ],
  checkpoint,
});
test("one native receiver per connection, shared by active leases and stopped after grace", async () => {
  const f = fixture(),
    p = f.create();
  try {
    await p.tick();
    assert.equal(f.calls(), 0);
    f.store.activity("u", f.sub.id, true);
    await p.tick();
    assert.equal(f.calls(), 1);
    const second = f.store.create("u", ["c"]);
    f.store.activity("u", second.id, true);
    await p.tick();
    assert.equal(f.calls(), 1);
    f.store.activity("u", f.sub.id, false);
    f.advance(IDLE_GRACE);
    await p.tick();
    assert.equal(f.aborts(), 0);
    f.advance(ACTIVITY_LEASE);
    await p.tick();
    await setImmediate();
    assert.equal(f.aborts(), 1);
    assert.equal(p.state("c").status, "idle");
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("native publish commits checkpoint with deduplicated events independently of polling", async () => {
  const f = fixture(),
    p = f.create();
  f.store.activity("u", f.sub.id, true);
  await p.tick();
  try {
    await f.publish(batch("native-1", "m1"));
    f.store.append("c", batch("poll-1", "poll").events, "poll-1");
    await f.publish(batch("native-2", "m1"));
    assert.equal(f.store.read("u", f.sub.id, 0).events.length, 2);
    assert.equal(
      (
        f.db
          .prepare("SELECT cursor FROM contract_push_checkpoints")
          .get() as any
      ).cursor,
      "native-2",
    );
    assert.equal(
      (f.db.prepare("SELECT cursor FROM contract_checkpoints").get() as any)
        .cursor,
      "poll-1",
    );
    await p.stop();
    const resumed = f.create();
    await resumed.tick();
    assert.deepEqual(f.checkpoints, [undefined, "native-2"]);
    await resumed.stop();
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("invalid native batch is not acknowledged and cannot advance checkpoint", async () => {
  const f = fixture(),
    p = f.create();
  f.store.activity("u", f.sub.id, true);
  await p.tick();
  try {
    await f.publish(batch("valid"));
    const bad = batch("invalid");
    bad.events.push({
      sourceId: "",
      event: {
        category: "messaging",
        type: "created",
        resourceType: "message",
      },
    });
    await assert.rejects(() => f.publish(bad), /invalid_event/);
    assert.equal(
      (
        f.db
          .prepare("SELECT cursor FROM contract_push_checkpoints")
          .get() as any
      ).cursor,
      "valid",
    );
    assert.equal(f.store.read("u", f.sub.id, 0).events.length, 1);
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("revoked or expired activity cannot publish late native events", async () => {
  const f = fixture(),
    p = f.create();
  f.store.activity("u", f.sub.id, true);
  await p.tick();
  try {
    f.advance(ACTIVITY_LEASE + IDLE_GRACE);
    await assert.rejects(() => f.publish(batch("late")), { code: "cancelled" });
    await p.tick();
    await setImmediate();
    assert.equal(f.store.head(), 0);
    assert.equal(f.aborts(), 1);
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("terminal native auth failure pauses polling and native retries until credentials change", async () => {
  const f = fixture();
  let attempts = 0;
  const p = f.create(() => ({
    check() {},
    async watch() {
      attempts++;
      throw Object.assign(Error("private failure details"), {
        reauthenticationRequired: true,
      });
    },
  }));
  f.store.activity("u", f.sub.id, true);
  try {
    await p.tick();
    await setImmediate();
    assert.equal(f.auth.state("c").status, "auth_required");
    await p.tick();
    assert.equal(attempts, 1);
    assert.equal((await f.auth.refresh("c", true)).status, "auth_required");
    f.auth.credentialsChanged("c");
    p.reset("c");
    await p.tick();
    await setImmediate();
    assert.equal(attempts, 2);
    assert.ok(
      !JSON.stringify(
        f.db.prepare("SELECT * FROM contract_push_state").all(),
      ).includes("private failure"),
    );
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("native backoff and Retry-After survive runtime recreation", async () => {
  const f = fixture();
  let attempts = 0;
  const resolve = () => ({
    check() {},
    async watch() {
      attempts++;
      throw { retryAfterMs: 120000 };
    },
  });
  const p = f.create(resolve);
  f.store.activity("u", f.sub.id, true);
  await p.tick();
  await setImmediate();
  assert.equal(p.state("c").nextAllowed, 1_120_000);
  await p.stop();
  const next = f.create(resolve);
  try {
    await next.tick();
    assert.equal(attempts, 1);
    f.advance(120000);
    await next.tick();
    await setImmediate();
    assert.equal(attempts, 2);
  } finally {
    await next.stop();
    f.db.close();
  }
});
test("unsupported source does not retry until plugin/configuration reset", async () => {
  const f = fixture();
  let resolutions = 0;
  const p = f.create(() => {
    resolutions++;
    return { check() {} };
  });
  f.store.activity("u", f.sub.id, true);
  try {
    await p.tick();
    await setImmediate();
    await p.tick();
    assert.equal(resolutions, 1);
    p.reset("c");
    await p.tick();
    await setImmediate();
    assert.equal(resolutions, 2);
  } finally {
    await p.stop();
    f.db.close();
  }
});
test("reset before native dispatch prevents stale connection work", async () => {
  const f = fixture(),
    p = f.create();
  f.store.activity("u", f.sub.id, true);
  const tick = p.tick();
  p.reset("c");
  await tick;
  await setImmediate();
  assert.equal(f.calls(), 0);
  assert.equal(p.state("c").status, "idle");
  await p.tick();
  assert.equal(f.calls(), 1);
  await p.stop();
  f.db.close();
});
