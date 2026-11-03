import { terminalAuthenticationError } from "../auth-errors.ts";
import type { ContractChangeBatch } from "../plugins/api.ts";
import { ContractStore } from "./store.ts";
import type { ContractCollectors } from "./runtime.ts";
export const CONTRACT_PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS contract_push_checkpoints(connection TEXT PRIMARY KEY,cursor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contract_push_state(connection TEXT PRIMARY KEY,state TEXT NOT NULL);
`;
export interface PushSource {
  check(): void;
  watch?(
    checkpoint: string | undefined,
    publish: (batch: ContractChangeBatch) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
interface PushState {
  nextAllowed: number;
  failures: number;
  status: "idle" | "watching" | "backoff" | "unsupported" | "auth_required";
  error?: string;
}
interface Task {
  controller: AbortController;
  promise: Promise<void>;
}
/** One native receiver per connection, shared by all authorized active consumers. */
export class ContractPushSources {
  readonly store: ContractStore;
  readonly resolve: (connection: string) => PushSource;
  readonly auth: Pick<ContractCollectors, "state" | "pauseAuthentication">;
  readonly clock: () => number;
  private tasks = new Map<string, Task>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    store: ContractStore,
    resolve: (connection: string) => PushSource,
    auth: Pick<ContractCollectors, "state" | "pauseAuthentication">,
    clock: () => number = Date.now,
  ) {
    this.store = store;
    this.resolve = resolve;
    this.auth = auth;
    this.clock = clock;
  }
  state(connection: string): PushState {
    const row = this.store.db
      .prepare("SELECT state FROM contract_push_state WHERE connection=?")
      .get(connection) as any;
    return row
      ? JSON.parse(row.state)
      : { nextAllowed: 0, failures: 0, status: "idle" };
  }
  private save(connection: string, state: PushState) {
    this.store.db
      .prepare(
        "INSERT INTO contract_push_state VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET state=excluded.state",
      )
      .run(connection, JSON.stringify(state));
  }
  reset(connection?: string) {
    for (const [id, task] of this.tasks)
      if (!connection || id === connection) task.controller.abort();
    if (connection)
      this.store.db
        .prepare("DELETE FROM contract_push_state WHERE connection=?")
        .run(connection);
    else this.store.db.exec("DELETE FROM contract_push_state");
  }
  async tick() {
    if (this.stopped) return;
    for (const [id, task] of this.tasks)
      if (
        !this.store.pollingAllowed(id) ||
        this.auth.state(id).status === "auth_required"
      )
        task.controller.abort();
    const ids = new Set<string>();
    for (const row of this.store.db
      .prepare(
        "SELECT connections FROM contract_subscriptions WHERE poll_until>?",
      )
      .all(this.clock()) as any[])
      for (const id of JSON.parse(row.connections)) ids.add(id);
    for (const id of ids) {
      if (this.tasks.has(id) || this.auth.state(id).status === "auth_required")
        continue;
      const state = this.state(id);
      if (state?.status === "unsupported" || state.nextAllowed > this.clock())
        continue;
      const task: Task = {
        controller: new AbortController(),
        promise: Promise.resolve(),
      };
      this.tasks.set(id, task);
      task.promise = Promise.resolve().then(() => this.run(id, task));
    }
    // Dispatch receivers without waiting for their long-lived loops to complete.
    await Promise.resolve();
  }
  private async run(id: string, task: Task) {
    const signal = task.controller.signal,
      old = this.state(id);
    const check = () => {
      if (signal.aborted || this.stopped || this.tasks.get(id) !== task)
        throw Object.assign(Error("cancelled"), { code: "cancelled" });
      if (this.auth.state(id).status === "auth_required")
        throw Object.assign(Error("authentication_required"), {
          code: "authentication_required",
        });
      if (!this.store.pollingAllowed(id))
        throw Object.assign(Error("inactive"), { code: "cancelled" });
    };
    try {
      check();
      const source = this.resolve(id);
      source.check();
      if (!source.watch) {
        this.save(id, { ...old, status: "unsupported" });
        return;
      }
      this.save(id, { ...old, status: "watching", error: undefined });
      const checkpoint = (
        this.store.db
          .prepare(
            "SELECT cursor FROM contract_push_checkpoints WHERE connection=?",
          )
          .get(id) as any
      )?.cursor;
      await source.watch(
        checkpoint,
        async (batch) => {
          check();
          source.check();
          this.store.append(id, batch.events, batch.checkpoint, "push");
          this.save(id, { status: "watching", failures: 0, nextAllowed: 0 });
        },
        signal,
      );
      check();
      throw Object.assign(Error("source_closed"), { code: "source_closed" });
    } catch (error: any) {
      if (signal.aborted || this.stopped || error?.code === "cancelled") return;
      if (
        terminalAuthenticationError(error) ||
        error?.code === "access_revoked"
      ) {
        this.save(id, {
          ...this.state(id),
          status: "auth_required",
          error: "authentication_required",
          nextAllowed: 0,
        });
        this.auth.pauseAuthentication(
          id,
          error?.code === "access_revoked"
            ? "access_revoked"
            : "authentication_required",
        );
        return;
      }
      const latest = this.state(id);
      const failures = latest.failures + 1;
      const delay = Math.max(
        60_000,
        Math.min(
          86400_000,
          Number(error?.retryAfterMs) ||
            Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4)),
        ),
      );
      this.save(id, {
        status: "backoff",
        failures,
        nextAllowed: this.clock() + delay,
        error: "source_unavailable",
      });
    } finally {
      this.tasks.delete(id);
      // Reset/abort must not overwrite a newer configuration reset or terminal auth pause.
      const state = this.state(id);
      if (signal.aborted && state?.status === "watching")
        this.save(id, { ...state, status: "idle" });
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 30_000);
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
