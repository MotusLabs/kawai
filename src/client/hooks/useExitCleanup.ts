import { useRef, useEffect } from 'react'

interface Session {
  id: string
}

/**
 * Clears `exitingSessions` after a removal settles.
 * - Clears immediately if the session reappears (kill failed/rolled back)
 * - Clears after a delay if it stays gone (normal removal)
 *
 * The map is bookkeeping for kill-failed rollback and for noticing a
 * resurrected session; rows are not rendered from it (they unmount with the
 * live list — holding them for an exit animation left ghost cards).
 *
 * @param sessions - Current list of sessions
 * @param exitingSessions - Map of sessions marked exiting on removal
 * @param clearExitingSession - Function to clear a session from exiting state
 * @param exitDuration - Grace period in ms before cleanup
 */
export function useExitCleanup(
  sessions: Session[],
  exitingSessions: Map<string, unknown>,
  clearExitingSession: (id: string) => void,
  exitDuration: number
): void {
  const exitCleanupTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))

    for (const id of exitingSessions.keys()) {
      if (currentIds.has(id)) {
        // Session is back in active list (kill failed) - clear immediately
        // Also cancel any pending cleanup timer
        const timer = exitCleanupTimers.current.get(id)
        if (timer) {
          clearTimeout(timer)
          exitCleanupTimers.current.delete(id)
        }
        clearExitingSession(id)
      } else if (!exitCleanupTimers.current.has(id)) {
        // Session is gone and no cleanup scheduled - schedule cleanup after the
        // rollback window
        const timer = setTimeout(() => {
          exitCleanupTimers.current.delete(id)
          clearExitingSession(id)
        }, exitDuration + 100)
        exitCleanupTimers.current.set(id, timer)
      }
    }
  }, [sessions, exitingSessions, clearExitingSession, exitDuration])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of exitCleanupTimers.current.values()) {
        clearTimeout(timer)
      }
      exitCleanupTimers.current.clear()
    }
  }, [])
}
