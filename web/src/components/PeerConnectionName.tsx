import type { Connection } from '../api';

/** The remote catalog name is context; the local name remains the call reference. */
export function PeerConnectionName({ connection, always = false }: { connection: Connection; always?: boolean }) {
  const peer = connection.peer;
  if (!peer?.connectionName || (!always && peer.connectionName === connection.name)) return null;
  const text = `${peer.online ? 'Name on peer' : 'Last known name on peer'}: ${peer.connectionName}`;
  return <p className="mt-0.5 [overflow-wrap:anywhere] text-xs text-zinc-600 dark:text-zinc-400" title={text}>{text}</p>;
}
