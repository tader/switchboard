import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { ChangeEvent } from "./model.ts";
export const CONTRACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS contract_subscriptions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,connections TEXT NOT NULL,active_until INTEGER NOT NULL DEFAULT 0,poll_until INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contract_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,connection TEXT NOT NULL,source_id TEXT NOT NULL,event TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(connection,source_id));
CREATE INDEX IF NOT EXISTS contract_events_created ON contract_events(created);
CREATE TABLE IF NOT EXISTS contract_checkpoints(connection TEXT PRIMARY KEY,cursor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contract_receipts(connection TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(connection,key));
CREATE TABLE IF NOT EXISTS contract_retention(id INTEGER PRIMARY KEY CHECK(id=1),through_seq INTEGER NOT NULL);
INSERT OR IGNORE INTO contract_retention VALUES(1,0);
`;
export const POLL_INTERVAL = 900_000,
  IDLE_GRACE = 900_000,
  ACTIVITY_LEASE = 90_000;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const buses = new WeakMap<DatabaseSync, EventEmitter>();
export class ContractStore {
  readonly db: DatabaseSync;
  readonly clock: () => number;
  constructor(db: DatabaseSync, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }
  private bus() {
    let b = buses.get(this.db);
    if (!b) {
      b = new EventEmitter();
      b.setMaxListeners(0);
      buses.set(this.db, b);
    }
    return b;
  }
  notify() {
    this.bus().emit("change");
  }
  onChange(listener: () => void) {
    const b = this.bus();
    b.on("change", listener);
    return () => {
      b.off("change", listener);
    };
  }

  create(owner: string, connections: string[]) {
    if (
      !owner ||
      !connections.length ||
      connections.length > 100 ||
      connections.some((x) => typeof x !== "string" || !x)
    )
      throw Error("invalid_subscription");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO contract_subscriptions VALUES(?,?,?,0,0,?)")
      .run(id, owner, JSON.stringify([...new Set(connections)]), this.clock());
    return { id, cursor: this.head() };
  }
  head() {
    return (
      Number(
        (
          this.db
            .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM contract_events")
            .get() as any
        ).n,
      ) ||
      Number(
        (
          this.db
            .prepare("SELECT through_seq AS n FROM contract_retention")
            .get() as any
        ).n,
      )
    );
  }
  subscription(owner: string, id: string) {
    const s = this.db
      .prepare("SELECT * FROM contract_subscriptions WHERE id=? AND owner=?")
      .get(id, owner) as any;
    if (!s) throw Error("subscription_not_found");
    return { ...s, connections: JSON.parse(s.connections) as string[] };
  }
  activity(owner: string, id: string, active: boolean) {
    this.subscription(owner, id);
    const now = this.clock();
    if (active)
      this.db
        .prepare(
          "UPDATE contract_subscriptions SET active_until=?,poll_until=? WHERE id=?",
        )
        .run(now + ACTIVITY_LEASE, now + ACTIVITY_LEASE + IDLE_GRACE, id);
    else
      this.db
        .prepare(
          "UPDATE contract_subscriptions SET active_until=0,poll_until=MIN(poll_until,?) WHERE id=?",
        )
        .run(now + IDLE_GRACE, id);
  }
  pollingAllowed(connection: string) {
    return (
      this.db
        .prepare(
          "SELECT connections FROM contract_subscriptions WHERE poll_until>?",
        )
        .all(this.clock()) as any[]
    ).some((s) => JSON.parse(s.connections).includes(connection));
  }
  remove(owner: string, id: string) {
    this.subscription(owner, id);
    this.db.prepare("DELETE FROM contract_subscriptions WHERE id=?").run(id);
    this.bus().emit("change");
  }
  append(
    connection: string,
    events: { sourceId: string; event: ChangeEvent }[],
    checkpoint: string,
    channel: "poll" | "push" = "poll",
  ) {
    if (
      typeof checkpoint !== "string" ||
      checkpoint.length > 65536 ||
      events.length > 10000
    )
      throw Error("invalid_batch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { sourceId, event } of events) {
        if (
          typeof sourceId !== "string" ||
          !sourceId ||
          sourceId.length > 1024 ||
          !["calendar", "email", "messaging"].includes(event.category) ||
          ![
            "created",
            "updated",
            "deleted",
            "invalidated",
            "resync.required",
          ].includes(event.type) ||
          !event.resourceType ||
          JSON.stringify(event).length > 8192
        )
          throw Error("invalid_event");
        const metadata = Object.fromEntries(
          [
            "category",
            "type",
            "resourceType",
            "resourceId",
            "collectionId",
            "version",
            "occurredAt",
          ]
            .filter((key) => (event as any)[key] !== undefined)
            .map((key) => {
              const value = (event as any)[key];
              if (typeof value !== "string" || value.length > 1024)
                throw Error("invalid_event");
              return [key, value];
            }),
        );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO contract_events(connection,source_id,event,created) VALUES(?,?,?,?)",
          )
          .run(connection, sourceId, JSON.stringify(metadata), this.clock());
      }
      this.db
        .prepare(
          `INSERT INTO ${channel === "push" ? "contract_push_checkpoints" : "contract_checkpoints"} VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET cursor=excluded.cursor`,
        )
        .run(connection, checkpoint);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.bus().emit("change");
  }
  read(owner: string, id: string, cursor: number, limit = 100) {
    const s = this.subscription(owner, id);
    const floor = Number(
      (
        this.db
          .prepare("SELECT through_seq AS n FROM contract_retention")
          .get() as any
      ).n,
    );
    if (!Number.isSafeInteger(cursor) || cursor < floor || cursor > this.head())
      throw Error("invalid_cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw Error("invalid_limit");
    const rows = this.db
      .prepare(
        `SELECT * FROM contract_events WHERE seq>? AND connection IN (${s.connections.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`,
      )
      .all(cursor, ...s.connections, limit) as any[];
    return {
      events: rows.map((r) => ({
        id: String(r.seq),
        connectionId: r.connection,
        ...JSON.parse(r.event),
        receivedAt: r.created,
      })),
      cursor: rows.at(-1)?.seq ?? this.head(),
    };
  }
  prune() {
    const expired = this.clock() - 7 * 86400_000;
    // A single global low-water mark makes eviction detectable for every consumer.
    let rows = this.db
      .prepare(
        "SELECT seq,created,length(CAST(event AS BLOB))+length(CAST(source_id AS BLOB))+length(CAST(connection AS BLOB)) AS bytes FROM contract_events ORDER BY seq DESC",
      )
      .all() as any[];
    let count = 0,
      bytes = 0,
      through = 0;
    for (const r of rows) {
      count++;
      bytes += Number(r.bytes);
      if (r.created < expired || count > 100000 || bytes > 128 * 1024 * 1024)
        through = Math.max(through, Number(r.seq));
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE contract_retention SET through_seq=MAX(through_seq,?)")
        .run(through);
      this.db.prepare("DELETE FROM contract_events WHERE seq<=?").run(through);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  intent(connection: string, key: string, input: unknown) {
    if (!key || key.length > 128) throw Error("invalid_idempotency_key");
    const hash = createHash("sha256").update(canonical(input)).digest("hex");
    const old = this.db
      .prepare(
        "SELECT hash,result FROM contract_receipts WHERE connection=? AND key=?",
      )
      .get(connection, key) as any;
    if (old) {
      if (old.hash !== hash) throw Error("idempotency_conflict");
      return JSON.parse(old.result);
    }
    this.db
      .prepare("INSERT INTO contract_receipts VALUES(?,?,?,?)")
      .run(connection, key, hash, JSON.stringify({ status: "uncertain" }));
    return null;
  }
  receipt(connection: string, key: string, result: unknown) {
    this.db
      .prepare(
        "UPDATE contract_receipts SET result=? WHERE connection=? AND key=?",
      )
      .run(JSON.stringify(result), connection, key);
  }
}
