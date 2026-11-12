import { one } from './db.ts';
import { localUpdateControl, lifecycle } from './updates/control.ts';

let installed = false;
let bootstrap: string | undefined;
/** Only installed by a Node IPC parent. No bearer credential or HTTP route. */
export function startLocalManager(setupUrl?: string) {
  if (!process.send || !process.connected) return;
  if (setupUrl) bootstrap = setupUrl;
  if (installed) return; installed = true;
  process.on('message', async (message: any) => {
    if (message?.kind !== 'local-manager' || !Number.isSafeInteger(message.id)) return;
    const ready = !!one("SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL");
    try {
      let result: unknown;
      if (message.action === 'status') {
        if (ready) bootstrap = undefined;
        const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM connection_attention")?.n ?? 0;
        result = { ready, lifecycle: lifecycle.state, attention: count, ...(await localUpdateControl('status') as object) };
      } else if (message.action === 'bootstrap') { result = { setupUrl: ready ? undefined : bootstrap }; }
      else if (ready && ['pair', 'check', 'update', 'cancel'].includes(message.action)) result = await localUpdateControl(message.action);
      else throw Error('Action unavailable');
      process.send?.({ kind: 'local-manager', id: message.id, result });
    } catch { process.send?.({ kind: 'local-manager', id: message.id, error: 'Local manager action unavailable' }); }
  });
}
