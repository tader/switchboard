import type { Connection } from '../api';
import { Button, Dialog } from './ui';
import { SharingMatrix } from './SharingMatrix';

export function ConnectionSharing({ connection, onClose }: { connection: Connection; onClose(): void }) {
  return <Dialog open onClose={onClose} title={`Sharing · ${connection.name}`} size="xl" description="Selected peers can use this connection. Credentials remain on the origin machine." footer={<Button onClick={onClose}>Done</Button>}>
    <SharingMatrix connections={[connection]} connectionId={connection.id} />
    {connection.readOnly && <p className="mt-3 text-xs text-zinc-500">Onward sharing remains usable only while each link in the chain permits access.</p>}
  </Dialog>;
}
