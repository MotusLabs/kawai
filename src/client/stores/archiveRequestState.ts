// Dependency-leaf request state lets both row fetching and selection fallback
// observe the same current-connection resolution, without store import cycles.
import { create } from 'zustand'

type RowStatus = 'unresolved' | 'pending' | 'unknown' | 'error'
interface ArchiveRowsState {
  epoch: number
  generation: number
  status: Record<string, RowStatus>
  blocked: Set<string>
  loading: boolean
  pageLoaded: boolean
  nextCursor: string | null
  error: string | null
}
export const useArchiveRowsStore = create<ArchiveRowsState>(() => ({
  epoch: -1, generation: 0, status: {}, blocked: new Set(), loading: false,
  pageLoaded: false, nextCursor: null, error: null,
}))

export function rowResolutionOwnsSelection(id: string, heldLive: boolean): boolean {
  const { status, blocked, epoch } = useArchiveRowsStore.getState()
  if (blocked.has(id)) return false
  // Unknown is owned until App clears the identity and shows its notice.
  // A later list must not race that effect by selecting a live fallback.
  return status[id] !== undefined || (epoch >= 0 && !heldLive)
}
