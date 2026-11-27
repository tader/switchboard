import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

interface WindowsAdapter {
  open(root: string, create: boolean): unknown;
  close(handle: unknown): void;
  read(handle: unknown, name: string, limit: number): Buffer;
  write(handle: unknown, temp: string, target: string, bytes: Buffer, replace: boolean): void;
  remove(handle: unknown, name: string): void;
  list(handle: unknown): string[];
}
let windows: WindowsAdapter | undefined;
export interface PreviewIO {
  read(name: string, limit: number): string;
  exists(name: string): boolean;
  list(): string[];
  write(temp: string, target: string, value: string, replace?: boolean): void;
  remove(name: string): void;
}
export function withPreviewIO<T>(root: string, create: boolean, operation: (io: PreviewIO) => T): T {
  if (process.platform === 'win32') {
    // Load only on demand: a missing/wrong-architecture adapter disables capture.
    windows ??= createRequire(import.meta.url)('../native/activity-preview-store/build/Release/preview_store.node');
    const adapter = windows!, handle = adapter.open(root, create);
    const io: PreviewIO = {
      read: (name, limit) => adapter.read(handle, name, limit).toString('utf8'),
      exists: name => { try { adapter.read(handle, name, 65536); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } },
      list: () => adapter.list(handle),
      write: (temp, target, value, replace = false) => adapter.write(handle, temp, target, Buffer.from(value), replace),
      remove: name => adapter.remove(handle, name),
    };
    try { return operation(io); } finally { adapter.close(handle); }
  }
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw Error('Owner-private preview storage required');
  const location = (name: string) => {
    if (!name || path.basename(name) !== name || name === '.' || name === '..') throw Error('Invalid preview file name');
    return path.join(root, name);
  };
  const io: PreviewIO = {
    read(name, limit) {
      const fd = fs.openSync(location(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const entry = fs.fstatSync(fd);
        if (!entry.isFile() || entry.uid !== stat.uid || entry.size > limit) throw Error('Invalid preview file');
        return fs.readFileSync(fd, 'utf8');
      } finally { fs.closeSync(fd); }
    },
    exists: name => fs.existsSync(location(name)),
    list: () => fs.readdirSync(root),
    write(temp, target, value, replace = false) {
      const fd = fs.openSync(location(temp), fs.constants.O_WRONLY | fs.constants.O_CREAT | (replace ? fs.constants.O_TRUNC : fs.constants.O_EXCL) | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(location(temp), location(target));
      const dir = fs.openSync(root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    },
    remove(name) {
      try {
        if (!fs.lstatSync(location(name)).isFile()) throw Error('Preview file is not a regular file');
        fs.unlinkSync(location(name));
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    },
  };
  return operation(io);
}
