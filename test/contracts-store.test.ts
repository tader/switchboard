import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ContractStore,
  CONTRACT_SCHEMA,
  IDLE_GRACE,
  ACTIVITY_LEASE,
} from "../server/contracts/store.ts";
function fixture() {
  let now = 1_000_000;
  const db = new DatabaseSync(":memory:");
  db.exec(CONTRACT_SCHEMA);
  return {
    db,
    store: new ContractStore(db, () => now),
    advance: (n: number) => {
      now += n;
    },
  };
}
test("activity expires without heartbeats; grace and multiple consumers", () => {
  const { db, store: s, advance } = fixture();
  try {
    const a = s.create("u", ["c"]),
      b = s.create("u", ["c"]);
    assert.equal(s.pollingAllowed("c"), false);
    s.activity("u", a.id, true);
    advance(ACTIVITY_LEASE + IDLE_GRACE - 1);
    assert.equal(s.pollingAllowed("c"), true);
    advance(1);
    assert.equal(s.pollingAllowed("c"), false);
    s.activity("u", b.id, true);
    s.activity("u", a.id, false);
    advance(IDLE_GRACE);
    assert.equal(s.pollingAllowed("c"), true);
    advance(ACTIVITY_LEASE);
    assert.equal(s.pollingAllowed("c"), false);
    assert.throws(() => s.subscription("other", a.id));
  } finally {
    db.close();
  }
});
test("atomic event/checkpoint, replay and rollback", () => {
  const { db, store: s } = fixture();
  try {
    const sub = s.create("u", ["c"]);
    const event = {
      category: "messaging" as const,
      type: "created" as const,
      resourceType: "message",
      resourceId: "m",
    };
    s.append("c", [{ sourceId: "1", event }], "checkpoint");
    s.append("c", [{ sourceId: "1", event }], "checkpoint");
    assert.equal(s.read("u", sub.id, 0).events.length, 1);
    assert.throws(() =>
      s.append(
        "c",
        [
          { sourceId: "2", event },
          { sourceId: "", event },
        ],
        "bad",
      ),
    );
    assert.equal(s.read("u", sub.id, 0).events.length, 1);
    assert.equal(
      (db.prepare("SELECT cursor FROM contract_checkpoints").get() as any)
        .cursor,
      "checkpoint",
    );
  } finally {
    db.close();
  }
});
test("expired events require resync even after restart", () => {
  const { db, store: s, advance } = fixture();
  try {
    const a = s.create("u", ["c"]);
    s.append(
      "c",
      [
        {
          sourceId: "x",
          event: {
            category: "calendar",
            type: "invalidated",
            resourceType: "events",
          },
        },
      ],
      "x",
    );
    advance(8 * 86400_000);
    s.prune();
    assert.throws(
      () => new ContractStore(db).read("u", a.id, 0),
      /invalid_cursor/,
    );
  } finally {
    db.close();
  }
});
test("uncertain intent survives recreation and canonical retry cannot resend", () => {
  const { db, store: s } = fixture();
  try {
    assert.equal(s.intent("c", "key", { b: 2, a: 1 }), null);
    assert.deepEqual(new ContractStore(db).intent("c", "key", { a: 1, b: 2 }), {
      status: "uncertain",
    });
    assert.throws(() => s.intent("c", "key", { a: 2 }), /idempotency_conflict/);
    s.receipt("c", "key", { status: "accepted", resourceId: "m" });
    assert.deepEqual(s.intent("c", "key", { a: 1, b: 2 }), {
      status: "accepted",
      resourceId: "m",
    });
  } finally {
    db.close();
  }
});

test("inactive heartbeats never start or prolong polling", () => {
  const { db, store: s, advance } = fixture();
  try {
    const a = s.create("u", ["c"]);
    s.activity("u", a.id, false);
    assert.equal(s.pollingAllowed("c"), false);
    s.activity("u", a.id, true);
    s.activity("u", a.id, false);
    advance(IDLE_GRACE - 1);
    s.activity("u", a.id, false);
    advance(1);
    assert.equal(s.pollingAllowed("c"), false);
  } finally {
    db.close();
  }
});
