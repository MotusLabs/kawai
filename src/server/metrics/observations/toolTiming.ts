// One managed turn's observed tool time (process-observability D3): tool
// intervals can overlap, so elapsed tool time is their union, while summed
// tool work can exceed it. Approval and question waits that overlap the union
// are subtracted from it.
import type { StoredObservation } from '../../../shared/processObservations'

type Interval = [number, number]

function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = []
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}

const timed = (row: StoredObservation) =>
  typeof row.data.durationSeconds === 'number' && typeof row.data.startedAt === 'string'

export function observedToolTiming(rows: readonly StoredObservation[]): {
  sumSeconds: number
  unionSeconds: number
} {
  const scopes = new Set(rows.map(row => JSON.stringify([row.sessionId, row.turnId])))
  if (scopes.size > 1) throw Error('Tool timing requires a single managed turn')
  const intervals = (kind: string): Interval[] =>
    rows
      .filter(row => row.kind === kind && timed(row))
      .map(row => [Date.parse(String(row.data.startedAt)), Date.parse(row.observedAt)] as Interval)
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
  const tools = union(intervals('tool'))
  const requests = union(intervals('request'))
  const elapsed = tools.reduce((sum, [start, end]) => sum + end - start, 0)
  const waiting = tools.reduce(
    (sum, [start, end]) =>
      sum +
      requests.reduce(
        (overlap, [waitStart, waitEnd]) =>
          overlap + Math.max(0, Math.min(end, waitEnd) - Math.max(start, waitStart)),
        0,
      ),
    0,
  )
  const sumSeconds = rows
    .filter(row => row.kind === 'tool' && typeof row.data.durationSeconds === 'number')
    .reduce((sum, row) => sum + Number(row.data.durationSeconds), 0)
  return { sumSeconds, unionSeconds: Math.max(0, elapsed - waiting) / 1000 }
}
