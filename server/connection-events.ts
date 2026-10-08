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
