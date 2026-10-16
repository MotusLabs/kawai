// Attribution and aggregation for the metrics core (team-process-metrics D4).
// The family modules turn records into observations — one per unit of work,
// tagged with the agent start (or sender group) on the metric's side — and
// this module resolves starts, keys observations by slice, and aggregates
// them into values with `n`, sufficiency, drill-down ids, and the fixed
// breakdown. Sides: author (a task's owner — the submitter's latest start at
// or before its first result — owns its first-pass outcome, every fix
// iteration, and all its tokens; `no result` without one; `mixed` counts
// owned tasks with a later result from a start of another slice value),
// reviewer (each finding's author's latest start), turn (the usage row's
// pinned start), sender (the sender's group only), team (none). Work with no
// recorded start lands in `unrecorded`. Pure.
import {
  MIN_SAMPLE, NO_RESULT_SLICE, UNRECORDED_SLICE, nearestRank,
  type MetricDef, type MetricId, type MetricRow, type MetricSlice, type MetricStat,
} from '../../shared/processMetrics'
import type { AgentStartRow } from './provenanceRecorder'

export type Attribution =
  | { kind: 'start'; start: AgentStartRow }
  | { kind: 'unrecorded' }
  | { kind: 'noResult' }
  /** Sender side: the group the mail came from. */
  | { kind: 'sender'; group: string }

export interface Observation {
  metric: MetricId
  /** For percentile, mean, and sum metrics. */
  value?: number
  /** For ratio and share metrics: what the observation adds above and below the line. */
  num?: number
  den?: number
  /** The breakdown row it belongs to; undefined on a denominator-only observation, which counts in every row. */
  key?: string
  /** Undefined on a denominator-only observation, which counts in every slice. */
  attribution?: Attribution
  /** Author side: the starts of the task's later results, for `mixed`. */
  later?: Attribution[]
  task?: string
  message?: string
  approximate?: boolean
  partial?: boolean
}

/** Latest-start lookups over the loaded starts (sorted by started_at, id). */
export class StartResolver {
  private readonly bySession = new Map<string, AgentStartRow[]>()
  private readonly byId = new Map<string, AgentStartRow>()

  constructor(starts: readonly AgentStartRow[]) {
    for (const start of starts) {
      this.byId.set(start.id, start)
      const list = this.bySession.get(start.sessionId) ?? []
      list.push(start)
      this.bySession.set(start.sessionId, list)
    }
  }

  /** The session's latest start at or before `at`, as an attribution. */
  latest(sessionId: string | null, at: string): Attribution {
    if (!sessionId) return { kind: 'unrecorded' }
    let found: AgentStartRow | null = null
    for (const start of this.bySession.get(sessionId) ?? []) {
      if (start.startedAt <= at) found = start
      else break
    }
    return found ? { kind: 'start', start: found } : { kind: 'unrecorded' }
  }

  byStartId(startId: string | null): Attribution {
    const start = startId ? this.byId.get(startId) : undefined
    return start ? { kind: 'start', start } : { kind: 'unrecorded' }
  }

  latestStart(sessionId: string, at: string): AgentStartRow | null {
    const attribution = this.latest(sessionId, at)
    return attribution.kind === 'start' ? attribution.start : null
  }
}

/** An attribution's value under a slice. */
export function sliceKey(attribution: Attribution, slice: MetricSlice, manifests: ReadonlyMap<string, Record<string, string>>): string {
  switch (attribution.kind) {
    case 'unrecorded': return UNRECORDED_SLICE
    case 'noResult': return NO_RESULT_SLICE
    case 'sender': return attribution.group
    case 'start': {
      const start = attribution.start
      switch (slice.kind) {
        case 'group': return start.groupId ?? 'no group'
        case 'profile': return start.profileId ?? 'default'
        case 'groupFileHash': return start.groupFileHash ?? 'no group file'
        case 'memoryFile': {
          if (!start.memoryHash) return 'no memory'
          return manifests.get(start.memoryHash)?.[slice.file] ?? 'absent'
        }
      }
    }
  }
}

export interface Aggregate extends MetricStat {
  approximate: boolean
  partial: boolean
  tasks: string[]
  messages: string[]
}

const stat = (value: number | null, n: number): MetricStat => ({ value: n === 0 ? null : value, n, insufficient: n < MIN_SAMPLE })

/** One value of `def` over `obs`. Denominator-only observations always count. */
export function aggregate(def: MetricDef, obs: readonly Observation[]): Aggregate {
  let result: MetricStat
  switch (def.aggregation) {
    case 'p50': case 'p90': {
      const values = obs.flatMap(o => (o.value === undefined ? [] : [o.value]))
      result = stat(nearestRank(values, def.aggregation === 'p50' ? 50 : 90), values.length)
      break
    }
    case 'mean': {
      const values = obs.flatMap(o => (o.value === undefined ? [] : [o.value]))
      result = stat(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, values.length)
      break
    }
    case 'sum': {
      const values = obs.flatMap(o => (o.value === undefined ? [] : [o.value]))
      result = stat(values.reduce((a, b) => a + b, 0), values.length)
      break
    }
    case 'ratio': {
      const num = obs.reduce((a, o) => a + (o.num ?? 0), 0)
      const den = obs.reduce((a, o) => a + (o.den ?? 0), 0)
      result = stat(den ? num / den : null, den)
      break
    }
    case 'shareOfTotal': {
      const den = obs.reduce((a, o) => a + (o.den ?? 0), 0)
      result = { ...stat(null, den), value: null }
      break
    }
  }
  return {
    ...result,
    approximate: obs.some(o => o.approximate),
    partial: obs.some(o => o.partial),
    tasks: [...new Set(obs.flatMap(o => (o.task ? [o.task] : [])))],
    messages: [...new Set(obs.flatMap(o => (o.message ? [o.message] : [])))],
  }
}

/** A row's value: its own observations plus every denominator-only one. For a share, its count over the whole. */
function rowStat(def: MetricDef, mine: readonly Observation[], all: readonly Observation[]): MetricStat {
  if (def.aggregation === 'shareOfTotal') {
    const den = all.reduce((a, o) => a + (o.den ?? 0), 0)
    const num = mine.reduce((a, o) => a + (o.num ?? 0), 0)
    return stat(den ? num / den : null, den)
  }
  const shared = all.filter(o => o.key === undefined && o.attribution === undefined)
  const { value, n, insufficient } = aggregate(def, [...mine, ...shared.filter(o => !mine.includes(o))])
  return { value, n, insufficient }
}

/** Rows of `obs` grouped by `keyOf` (undefined = shared); the baseline rows join by key. */
export function rows(
  def: MetricDef,
  current: readonly Observation[],
  baseline: readonly Observation[],
  keyOf: (o: Observation) => string | undefined,
  mixedOf?: (o: Observation, key: string) => boolean,
): MetricRow[] {
  const group = (obs: readonly Observation[]) => {
    const map = new Map<string, Observation[]>()
    for (const o of obs) {
      const key = keyOf(o)
      if (key === undefined) continue
      map.set(key, [...(map.get(key) ?? []), o])
    }
    return map
  }
  const now = group(current)
  const before = group(baseline)
  const keys = [...new Set([...now.keys(), ...before.keys()])].sort()
  return keys.map(key => {
    const mine = now.get(key) ?? []
    const row: MetricRow = {
      key, ...rowStat(def, mine, current),
      baseline: rowStat(def, before.get(key) ?? [], baseline),
    }
    if (mixedOf) row.mixed = mine.filter(o => mixedOf(o, key)).length
    return row
  })
}
