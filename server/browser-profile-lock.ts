/** Serialize browser use by profile. A failed operation must not poison the queue. */
export class BrowserProfileLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(profile: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(profile) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => next);
    this.tails.set(profile, tail);
    try {
      if (signal) {
        signal.throwIfAborted();
        let abort!: () => void;
        const aborted = new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([previous, aborted]); }
        finally { signal.removeEventListener('abort', abort); }
      } else await previous;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
      void tail.then(() => { if (this.tails.get(profile) === tail) this.tails.delete(profile); });
    }
  }
}
