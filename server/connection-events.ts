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

const credentialListeners = new Set<(id: string, changed: boolean) => void>();
export function onCredentialsChange(listener: (id: string, changed: boolean) => void) { credentialListeners.add(listener); return () => { credentialListeners.delete(listener); }; }
/** Replacement still interrupts protocol sessions even when it preserves the same value. */
export function credentialsChanged(id: string, changed = true) { for (const listener of credentialListeners) listener(id, changed); }
