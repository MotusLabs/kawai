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

/**
 * Log the end-to-end time from attach-send to the first terminal output
 * (server roundtrip plus parse diagnostics), then clear the switch start so
 * only the first output after a switch is logged.
 */
export function logFirstOutputAfterSwitch(
  message: { sessionId: string; data: string } & Record<string, unknown>,
  switchStart: number,
  clear: () => void
): void {
  clientLog('switch_first_output', {
    sessionId: message.sessionId,
    serverRoundtripMs: Math.round(performance.now() - switchStart),
    bytes: message.data.length,
    parseMs: (message as { _parseMs?: number })._parseMs ?? -1,
    rawLength: (message as { _rawLength?: number })._rawLength ?? -1,
  })
  clear()
}
