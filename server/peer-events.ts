const listeners = new Set<(peerId: string) => void>();
export function onPeerDisconnected(listener: (peerId: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function peerDisconnected(id: string) { for (const listener of listeners) listener(id); }
