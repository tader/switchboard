import { ACTIVITY_LEASE, POLL_INTERVAL, ContractStore } from "./store.ts";
import type { ChangeEvent } from "./model.ts";
export interface CollectionBatch {
  events: { sourceId: string; event: ChangeEvent }[];
  checkpoint: string;
}
export interface CollectorSource {
  /** Rechecks live permissions and terminal authentication state before network work. */
  check(): void;
  collect(
    checkpoint: string | undefined,
    signal: AbortSignal,
  ): Promise<CollectionBatch>;
}
export const CONTRACT_RUNTIME_SCHEMA =
  "CREATE TABLE IF NOT EXISTS contract_collectors(connection TEXT PRIMARY KEY,state TEXT NOT NULL);";
export interface CollectorState {
  status: "idle" | "running" | "ready" | "auth_required" | "backoff";
  lastSuccess: number | null;
  nextAllowed: number;
  error?: string;
}
interface Task {
  controller: AbortController;
  promise: Promise<RefreshResult>;
}
export interface RefreshResult {
  status:
    | "completed"
    | "coalesced"
    | "deferred"
    | "auth_required"
    | "idle"
    | "failed";
  retryAfterMs?: number;
}
/** One runtime per owning Switchboard. Clients never invoke provider polling loops. */
export class ContractCollectors {
  private states = new Map<string, CollectorState>();
  private tasks = new Map<string, Task>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  readonly store: ContractStore;
  readonly resolve: (connection: string) => CollectorSource;
  readonly clock: () => number;
  constructor(
    store: ContractStore,
    resolve: (connection: string) => CollectorSource,
    clock: () => number = Date.now,
  ) {
    this.store = store;
    this.resolve = resolve;
    this.clock = clock;
  }
  state(connection: string): CollectorState {
    const saved = this.store.db
      .prepare("SELECT state FROM contract_collectors WHERE connection=?")
      .get(connection) as any;
    return {
      ...(this.states.get(connection) ??
        (saved
          ? JSON.parse(saved.state)
          : { status: "idle", lastSuccess: null, nextAllowed: 0 })),
    };
  }
  private update(connection: string, state: CollectorState) {
    this.states.set(connection, state);
    this.store.db
      .prepare(
        "INSERT INTO contract_collectors VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET state=excluded.state",
      )
      .run(connection, JSON.stringify(state));
  }
  /** Explicit reauthentication/configuration changes are the only way out of terminal auth pause. */
  credentialsChanged(connection: string) {
    const old = this.state(connection);
    this.update(connection, {
      ...old,
      status: "idle",
      error: undefined,
      nextAllowed: 0,
    });
  }
  pauseAuthentication(connection: string) {
    const old = this.state(connection);
    this.update(connection, {
      ...old,
      status: "auth_required",
      error: "authentication_required",
    });
    this.tasks.get(connection)?.controller.abort();
  }
  async refresh(connection: string, manual = false): Promise<RefreshResult> {
    if (this.stopped) return { status: "idle" };
    const old = this.state(connection),
      now = this.clock();
    if (old.status === "auth_required") return { status: "auth_required" };
    if (!manual && !this.store.pollingAllowed(connection)) {
      this.update(connection, { ...old, status: "idle" });
      return { status: "idle" };
    }
    const existing = this.tasks.get(connection);
    if (existing) {
      await existing.promise;
      return { status: "coalesced" };
    }
    const due = Math.max(
      old.nextAllowed,
      !manual && old.lastSuccess !== null ? old.lastSuccess + POLL_INTERVAL : 0,
    );
    if (now < due) return { status: "deferred", retryAfterMs: due - now };
    const controller = new AbortController();
    // Dispatch after registering the task, so synchronous/reentrant requests also coalesce.
    const promise = Promise.resolve().then(async (): Promise<RefreshResult> => {
      this.update(connection, { ...old, status: "running" });
      try {
        const source = this.resolve(connection);
        source.check();
        const checkpoint = (
          this.store.db
            .prepare(
              "SELECT cursor FROM contract_checkpoints WHERE connection=?",
            )
            .get(connection) as any
        )?.cursor;
        const batch = await source.collect(checkpoint, controller.signal);
        if (controller.signal.aborted) return { status: "idle" };
        source.check();
        this.store.append(connection, batch.events, batch.checkpoint);
        this.update(connection, {
          status: "ready",
          lastSuccess: this.clock(),
          nextAllowed: this.clock() + 60_000,
        });
        return { status: "completed" };
      } catch (error: any) {
        if (controller.signal.aborted) {
          this.update(connection, { ...old, status: "idle" });
          return { status: "idle" };
        }
        const terminal = [
          "auth_required",
          "authentication_required",
          "invalid_grant",
          "permission_denied",
          "access_revoked",
        ].includes(error.code);
        const delay = Math.max(
          60_000,
          Math.min(86400_000, Number(error.retryAfterMs) || POLL_INTERVAL),
        );
        // Error text from providers may contain secrets or message contents: store codes only.
        this.update(connection, {
          ...old,
          status: terminal ? "auth_required" : "backoff",
          nextAllowed: this.clock() + delay,
          error: terminal
            ? error.code === "access_revoked"
              ? "access_revoked"
              : "authentication_required"
            : "source_unavailable",
        });
        return {
          status: terminal ? "auth_required" : "failed",
          ...(terminal ? {} : { retryAfterMs: delay }),
        };
      } finally {
        this.tasks.delete(connection);
      }
    });
    this.tasks.set(connection, { controller, promise });
    return promise;
  }
  async tick() {
    const connections = new Set<string>();
    for (const row of this.store.db
      .prepare(
        "SELECT connections FROM contract_subscriptions WHERE poll_until>?",
      )
      .all(this.clock()) as any[])
      for (const id of JSON.parse(row.connections)) connections.add(id);
    for (const [id, task] of this.tasks)
      if (!this.store.pollingAllowed(id)) task.controller.abort();
    await Promise.allSettled([...connections].map((id) => this.refresh(id)));
    this.store.prune();
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(
      () => void this.tick(),
      Math.min(ACTIVITY_LEASE, 30_000),
    );
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((t) => t.promise));
  }
}
