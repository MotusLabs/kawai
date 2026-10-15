// Elapsed-time formatting and the shared client clock for chat rows (the
// activity row and the worker rows tick each second; the usage bar's time
// marker each minute): the server sends a snapshot age or reset time, the
// client anchors it on its own clock, and the timer ticks locally — no server
// traffic while a row runs.
import { useEffect, useState } from 'react'

/** `Ns` under a minute, `Mm Ss` beyond it. */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Date.now(), reticking every intervalMs (default one second) while active. */
export function useTickingClock(active: boolean, intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
