import { createLocalRecoveryInvite, ensureAdmin, listUsers } from './users.ts';
import { one } from './db.ts';
import { localUpdateControl, lifecycle } from './updates/control.ts';

export function localAccountCapabilities(): string[] {
  return process.connected && typeof process.send === 'function'
    && process.env.SWITCHBOARD_INSTALL_MODE === 'runtime' && process.env.SWITCHBOARD_LOCAL_ACCOUNT_RECOVERY === '1'
    ? ['account-users', 'account-setup', 'account-recovery'] : [];
}
export function localAccountAction(action: string, userId?: unknown): unknown {
  if (!localAccountCapabilities().includes(action)) throw Error('Account action unavailable');
  if (action === 'account-users') return { users: listUsers().filter(u => !u.disabled).map(u => ({ id: u.id, username: u.username })) };
  if (action === 'account-setup') return { setupUrl: ensureAdmin() };
  if (action === 'account-recovery' && typeof userId === 'string') return { setupUrl: createLocalRecoveryInvite(userId).url };
  throw Error('Account action unavailable');
}
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
      } else if (message.action === 'bootstrap') { result = { setupUrl: ready ? undefined : bootstrap, accountCapabilities: localAccountCapabilities() }; }
      else if (localAccountCapabilities().includes(message.action)) result = localAccountAction(message.action, message.userId);
      else if (ready && ['pair', 'check', 'update', 'cancel'].includes(message.action)) result = await localUpdateControl(message.action);
      else throw Error('Action unavailable');
      process.send?.({ kind: 'local-manager', id: message.id, result });
    } catch { process.send?.({ kind: 'local-manager', id: message.id, error: 'Local manager action unavailable' }); }
  });
}
