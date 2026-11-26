export interface DisplayClock { monotonic: number; wall: number }
export function displayGrantActive(grant: DisplayClock, at: DisplayClock): boolean {
  return at.monotonic < grant.monotonic && at.wall < grant.wall;
}
/** A renewal cannot revive an elapsed grant, even if it runs before overdue timers on resume. */
export function acceptDisplayGrant(previous: DisplayClock | undefined, sent: DisplayClock, duration: number, at: DisplayClock): DisplayClock | undefined {
  if (previous && !displayGrantActive(previous, at)) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const bounded = Math.min(15_000, duration);
  const next = { monotonic: sent.monotonic + bounded, wall: sent.wall + bounded };
  return displayGrantActive(next, at) ? next : undefined;
}
