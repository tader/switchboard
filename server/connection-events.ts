/** In-flight work must stop when its connection or providing plugin changes. */
type Listener = (connectionId?: string) => void;
const listeners = new Set<Listener>();
export function onConnectionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function connectionChanged(id?: string) {
  for (const listener of listeners) listener(id);
}

const credentialListeners = new Set<(id: string) => void>();
export function onCredentialsChange(listener: (id: string) => void) { credentialListeners.add(listener); return () => { credentialListeners.delete(listener); }; }
export function credentialsChanged(id: string) { for (const listener of credentialListeners) listener(id); }
