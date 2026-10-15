// SessionId → serialized terminal content. Survives component remounts and
// avoids stale-closure issues in effects, so switching back to a session can
// show its last content instantly while fresh history streams in.
const snapshotCache = new Map<string, string>()
const MAX_SNAPSHOT_ENTRIES = 20

/** Remove a single session's cached terminal snapshot. */
export function invalidateSnapshotCache(sessionId: string): void {
  snapshotCache.delete(sessionId)
}

/** Clear all cached terminal snapshots (e.g. on reconnect). */
export function clearSnapshotCache(): void {
  snapshotCache.clear()
}

/** Read a session's cached snapshot, if one exists. */
export function getCachedSnapshot(sessionId: string): string | undefined {
  return snapshotCache.get(sessionId)
}

/** Store a session's serialized content, evicting the oldest entry over the limit. */
export function cacheSnapshot(sessionId: string, serialized: string): void {
  snapshotCache.set(sessionId, serialized)
  // Evict oldest entry if over limit
  if (snapshotCache.size > MAX_SNAPSHOT_ENTRIES) {
    const oldest = snapshotCache.keys().next().value
    if (oldest) snapshotCache.delete(oldest)
  }
}
