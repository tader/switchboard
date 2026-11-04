import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ContractStore,
  CONTRACT_SCHEMA,
  POLL_INTERVAL,
  IDLE_GRACE,
  ACTIVITY_LEASE,
} from "../server/contracts/store.ts";
import {
  ContractCollectors,
  CONTRACT_RUNTIME_SCHEMA,
} from "../server/contracts/runtime.ts";
function fixture() {
  let now = 1_000_000,
    calls = 0;
  const db = new DatabaseSync(":memory:");
  db.exec(CONTRACT_SCHEMA + CONTRACT_RUNTIME_SCHEMA);
  const store = new ContractStore(db, () => now);
  const sub = store.create("owner", ["c"]);
  const runtime = new ContractCollectors(
    store,
    () => ({
      check() {},
      async collect() {
        calls++;
        return { events: [], checkpoint: String(calls) };
      },
    }),
    () => now,
  );
  return {
    db,
    store,
    sub,
    runtime,
    advance: (n: number) => (now += n),
    calls: () => calls,
  };
}
test("inactive sources do not poll; passive streaming does not renew activity", async () => {
  const f = fixture();
  try {
    await f.runtime.tick();
    assert.equal(f.calls(), 0);
    f.store.activity("owner", f.sub.id, true);
    await f.runtime.tick();
    assert.equal(f.calls(), 1);
    f.store.read("owner", f.sub.id, 0);
    f.advance(ACTIVITY_LEASE + IDLE_GRACE);
    await f.runtime.tick();
    assert.equal(f.calls(), 1);
  } finally {
    await f.runtime.stop();
    f.db.close();
  }
});
test("15-minute background interval and explicit 60-second refresh budget", async () => {
  const f = fixture();
  try {
    f.store.activity("owner", f.sub.id, true);
    await f.runtime.tick();
    await f.runtime.tick();
    assert.equal(f.calls(), 1);
    f.advance(POLL_INTERVAL);
    f.store.activity("owner", f.sub.id, true);
    await f.runtime.tick();
    assert.equal(f.calls(), 2);
    f.advance(POLL_INTERVAL);
    assert.equal((await f.runtime.refresh("c", true)).status, "completed");
    assert.equal((await f.runtime.refresh("c", true)).status, "deferred");
    assert.equal(f.calls(), 3);
  } finally {
    await f.runtime.stop();
    f.db.close();
  }
});
test("concurrent refreshes coalesce into one upstream read", async () => {
  const f = fixture();
  try {
    const result = await Promise.all([
      f.runtime.refresh("c", true),
      f.runtime.refresh("c", true),
    ]);
    assert.equal(f.calls(), 1);
    assert.deepEqual(
      result.map((x) => x.status),
      ["completed", "coalesced"],
    );
  } finally {
    await f.runtime.stop();
    f.db.close();
  }
});
test("terminal auth pauses until explicit credential change, without repeated network attempts", async () => {
  const f = fixture();
  let fail = true,
    checks = 0;
  const runtime = new ContractCollectors(f.store, () => ({
    check() {
      checks++;
      if (fail)
        throw Object.assign(Error("secret provider details"), {
          code: "invalid_grant",
        });
    },
    async collect() {
      return { events: [], checkpoint: "ok" };
    },
  }));
  try {
    assert.equal((await runtime.refresh("c", true)).status, "auth_required");
    assert.equal((await runtime.refresh("c", true)).status, "auth_required");
    assert.equal(checks, 1);
    const restarted = new ContractCollectors(f.store, () => {
      throw Error("Must not resolve while auth paused");
    });
    assert.equal((await restarted.refresh("c", true)).status, "auth_required");
    await restarted.stop();
    assert.equal(runtime.state("c").error, "authentication_required");
    fail = false;
    runtime.credentialsChanged("c");
    assert.equal((await runtime.refresh("c", true)).status, "completed");
  } finally {
    await runtime.stop();
    f.db.close();
  }
});
test("Retry-After delays manual requests as well as background jobs", async () => {
  const f = fixture();
  const runtime = new ContractCollectors(
    f.store,
    () => ({
      check() {},
      async collect() {
        throw Object.assign(Error("rate limit"), { retryAfterMs: 120_000 });
      },
    }),
    () => 1_000_000,
  );
  try {
    await runtime.refresh("c", true);
    assert.deepEqual(await runtime.refresh("c", true), {
      status: "deferred",
      retryAfterMs: 120_000,
    });
  } finally {
    await runtime.stop();
    f.db.close();
  }
});

test("losing activity aborts in-flight reads and never advances checkpoint", async () => {
  const f = fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const runtime = new ContractCollectors(
    f.store,
    () => ({
      check() {},
      collect(_checkpoint, signal) {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(Error("aborted")), {
            once: true,
          }),
        );
      },
    }),
    () => 1_000_000,
  );
  f.store.activity("owner", f.sub.id, true);
  const refresh = runtime.refresh("c");
  await ready;
  f.store.remove("owner", f.sub.id);
  await runtime.tick();
  assert.equal((await refresh).status, "idle");
  assert.equal(runtime.state("c").status, "idle");
  assert.equal(
    f.db.prepare("SELECT * FROM contract_checkpoints").get(),
    undefined,
  );
  await runtime.stop();
  f.db.close();
});

for (const completion of ["resolve", "reject"] as const) {
  test(`auth pause survives a late collector ${completion}`, async () => {
    const f = fixture();
    let finish!: (value?: any) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const runtime = new ContractCollectors(f.store, () => ({
      check() {},
      collect() {
        started();
        return new Promise((resolve, reject) => {
          finish = completion === "resolve" ? resolve : reject;
        });
      },
    }));
    const task = runtime.refresh("c", true);
    await ready;
    runtime.pauseAuthentication("c");
    finish(
      completion === "resolve"
        ? { events: [], checkpoint: "stale" }
        : Error("aborted"),
    );
    assert.equal((await task).status, "auth_required");
    assert.equal(runtime.state("c").status, "auth_required");
    assert.equal((await runtime.refresh("c", true)).status, "auth_required");
    assert.equal(
      f.db.prepare("SELECT * FROM contract_checkpoints").get(),
      undefined,
    );
    await runtime.stop();
    f.db.close();
  });
}
test("old credentials failure cannot pause freshly changed credentials", async () => {
  const f = fixture();
  let reject!: (e: any) => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const runtime = new ContractCollectors(f.store, () => ({
    check() {},
    collect() {
      started();
      return new Promise((_resolve, r) => (reject = r));
    },
  }));
  const task = runtime.refresh("c", true);
  await ready;
  runtime.credentialsChanged("c");
  reject(Object.assign(Error("old session failed"), { code: "invalid_grant" }));
  assert.equal((await task).status, "idle");
  assert.equal(runtime.state("c").status, "idle");
  assert.equal(runtime.state("c").error, undefined);
  await runtime.stop();
  f.db.close();
});

test("a pause before dispatch releases the task so reauthentication can resume", async () => {
  const f = fixture();
  const task = f.runtime.refresh("c", true);
  f.runtime.pauseAuthentication("c");
  assert.equal((await task).status, "auth_required");
  assert.equal(f.calls(), 0);
  f.runtime.credentialsChanged("c");
  assert.equal((await f.runtime.refresh("c", true)).status, "completed");
  assert.equal(f.calls(), 1);
  await f.runtime.stop();
  f.db.close();
});

test("native-only sources have no polling failure and respect a bounded capability recheck", async () => {
  const f = fixture();
  let attempts = 0;
  const runtime = new ContractCollectors(
    f.store,
    () => ({
      check() {},
      async collect() {
        attempts++;
        throw Object.assign(Error("unsupported"), {
          code: "collector_not_supported",
        });
      },
    }),
    () => 1_000_000,
  );
  f.store.activity("owner", f.sub.id, true);
  try {
    assert.equal((await runtime.refresh("c")).status, "unsupported");
    assert.equal(runtime.state("c").error, undefined);
    assert.equal(runtime.state("c").status, "unsupported");
    assert.equal((await runtime.refresh("c")).status, "deferred");
    assert.equal(attempts, 1);
  } finally {
    await runtime.stop();
    f.db.close();
  }
});
