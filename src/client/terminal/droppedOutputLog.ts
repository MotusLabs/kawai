// Rate-limited terminal_output_dropped diagnostics (design D8): at most one
// clientLog post per 5 s. Events suppressed inside the window fold into the
// next emitted report's count; the first report carries zero and no trailing
// report closes a burst. The clock is performance.now (monotonic) and can be
// injected for tests.
import { clientLog } from '../utils/clientLog'

const DROPPED_OUTPUT_LOG_INTERVAL_MS = 5000
let droppedOutputClock: () => number = () => performance.now()
let lastDroppedOutputLogAt = Number.NEGATIVE_INFINITY
let suppressedDroppedOutputReports = 0

export function logTerminalOutputDropped(fields: Record<string, unknown>): void {
  const now = droppedOutputClock()
  if (now - lastDroppedOutputLogAt < DROPPED_OUTPUT_LOG_INTERVAL_MS) {
    suppressedDroppedOutputReports += 1
    return
  }
  lastDroppedOutputLogAt = now
  clientLog(
    'terminal_output_dropped',
    { ...fields, suppressed: suppressedDroppedOutputReports },
    'info'
  )
  suppressedDroppedOutputReports = 0
}

/** Test-only: reset the dropped-output limiter, optionally injecting its clock. */
export function resetDroppedOutputRateLimiterForTests(now?: () => number): void {
  droppedOutputClock = now ?? (() => performance.now())
  lastDroppedOutputLogAt = Number.NEGATIVE_INFINITY
  suppressedDroppedOutputReports = 0
}
