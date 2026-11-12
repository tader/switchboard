import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** The OS releases SQLite's exclusive lock even after SIGKILL or a container restart. */
export function lockInstance(dataDir: string): () => void {
  const lease = new DatabaseSync(path.join(dataDir, '.server-lease.db'));
  try {
    lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease(id INTEGER); BEGIN EXCLUSIVE;');
  } catch {
    lease.close(); throw Error('Another server is using this data directory');
  }
  const file = path.join(dataDir, '.server-lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { mode: 0o600 });
  return () => { fs.rmSync(file, { force: true }); lease.close(); };
}
