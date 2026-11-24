// Agent paging of metric drill lists (bounded-metrics-reads D2): one list
// (`tasks`, `messages`, or `toolStreaks`) of one metric, from a live window
// at a fixed end or from a stored report's frozen snapshot. The cursor is
// base64url JSON bound to the team, the source, the window end, the metric,
// the list, and the page size; for a live tool-streak list it carries the
// human pager's own cursor, so the high-water mark and `(closedAt, seq)`
// order are that pager's. Decoding is strict — every field checked, unknown
// fields refused — and a cursor of another team is refused, never read for
// the caller. Task and message lists page in code-unit id order after the
// last id returned. Pages copy before sorting: nothing read here is mutated.
import {
  METRIC_IDS, METRIC_WINDOWS, isMetricId, isMetricWindow,
  type MetricId, type MetricSlice, type MetricWindow, type ProcessMetrics, type ToolStreakEntry,
  type MetricDrillMessage, type MetricDrillTask,
} from '../../shared/processMetrics'
import type { MetricsReader } from './computeMetrics'
import { toolDrillCursorEnd, validSlice } from './toolDrill'

export const DRILL_LISTS = ['tasks', 'messages', 'toolStreaks'] as const
export type DrillList = (typeof DRILL_LISTS)[number]
/** The metrics whose drill holds pageable tool streaks. */
export const TOOL_STREAK_METRICS: readonly MetricId[] = ['tool_abandoned_streaks']
export const DRILL_LIMITS = { list: { max: 200, default: 100 }, toolStreaks: { max: 50, default: 50 } } as const

type Source = { kind: 'live'; window: MetricWindow; slice: MetricSlice | null; end: string } | { kind: 'report'; reportId: string }
interface DrillCursor {
  v: 1
  team: string
  src: Source
  metric: MetricId
  list: DrillList
  limit: number
  after: string
  tool?: string
}

export type DrillEntry = MetricDrillTask | MetricDrillMessage | ToolStreakEntry
export interface DrillPage {
  metric: MetricId
  list: DrillList
  total: number
  /** Report tool streaks only: how many entries the stored snapshot holds (at most 50 of `total`). */
  reachable?: number
  entries: DrillEntry[]
  next: string | null
  source: { kind: 'live'; window: MetricWindow; end: string } | { kind: 'report'; reportId: string }
}

/** The stored reports a drill may read: the caller's team only. */
export interface DrillReports {
  report(teamId: string, id: string): { snapshot: ProcessMetrics } | null
}

/** A first-page request or a continuation, as the tool's schema parses it. */
export interface DrillRequest {
  cursor?: string
  window?: string
  slice?: MetricSlice | null
  end?: string
  report_id?: string
  metric?: string
  list?: string
  limit?: number
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',')
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const isList = (v: unknown): v is DrillList => typeof v === 'string' && (DRILL_LISTS as readonly string[]).includes(v)

function limitRange(list: DrillList) {
  return list === 'toolStreaks' ? DRILL_LIMITS.toolStreaks : DRILL_LIMITS.list
}

function checkLimit(list: DrillList, limit: number | undefined): number {
  const range = limitRange(list)
  if (limit === undefined) return range.default
  if (!Number.isInteger(limit) || limit < 1 || limit > range.max) {
    throw new Error(`limit must be an integer 1–${range.max} for ${list === 'toolStreaks' ? 'toolStreaks' : 'tasks and messages'}.`)
  }
  return limit
}

function checkMetricList(metric: unknown, list: unknown): { metric: MetricId; list: DrillList } {
  if (!isMetricId(metric)) throw new Error(`Unknown metric "${String(metric)}". Allowed metrics: ${METRIC_IDS.join(', ')}.`)
  if (!isList(list)) throw new Error(`Unknown list "${String(list)}". Allowed lists: ${DRILL_LISTS.join(', ')}.`)
  if (list === 'toolStreaks' && !TOOL_STREAK_METRICS.includes(metric)) {
    throw new Error(`Metric ${metric} has no tool streaks. Metrics with tool streaks: ${TOOL_STREAK_METRICS.join(', ')}.`)
  }
  return { metric, list }
}

const INVALID = 'Invalid drill cursor: pass the next value of a team_metrics_drill page unchanged.'

function validSource(v: unknown): v is Source {
  if (!object(v)) return false
  if (v.kind === 'live') return exactKeys(v, ['kind', 'window', 'slice', 'end']) && isMetricWindow(v.window) && validSlice(v.slice) && iso(v.end)
  if (v.kind === 'report') return exactKeys(v, ['kind', 'reportId']) && typeof v.reportId === 'string' && v.reportId.length > 0
  return false
}

export function decodeDrillCursor(raw: string): DrillCursor {
  try {
    if (!raw.length || raw.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error()
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) throw Error()
    const v: unknown = JSON.parse(bytes.toString('utf8'))
    if (!object(v) || v.v !== 1 || typeof v.team !== 'string' || !validSource(v.src)) throw Error()
    const liveStreaks = v.list === 'toolStreaks' && v.src.kind === 'live'
    const fields = ['v', 'team', 'src', 'metric', 'list', 'limit', 'after', ...(liveStreaks ? ['tool'] : [])]
    if (!exactKeys(v, fields) || typeof v.after !== 'string' || !v.after.length) throw Error()
    const { list } = checkMetricList(v.metric, v.list)
    if (typeof v.limit !== 'number') throw Error()
    checkLimit(list, v.limit)
    if (liveStreaks && (typeof v.tool !== 'string' || toolDrillCursorEnd(v.tool) !== (v.src as { end: string }).end)) throw Error()
    return v as unknown as DrillCursor
  } catch { throw new Error(INVALID) }
}

const encode = (cursor: DrillCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** One page of a task or message list in id order, after `after`. */
function idPage(items: readonly (MetricDrillTask | MetricDrillMessage)[], after: string | null, limit: number) {
  const sorted = [...items].sort(byId)
  const rest = after === null ? sorted : sorted.filter(item => item.id > after)
  const entries = rest.slice(0, limit)
  return { total: sorted.length, entries, last: rest.length > entries.length ? entries.at(-1)!.id : null }
}

/** One page of a report's stored tool streaks, in stored order, after the fact `after`. */
function storedStreakPage(items: readonly ToolStreakEntry[], after: string | null, limit: number) {
  const start = after === null ? 0 : items.findIndex(item => String(item.factId) === after) + 1
  if (start === 0 && after !== null) throw new Error(INVALID)
  const entries = items.slice(start, start + limit)
  return { entries, last: start + entries.length < items.length ? String(entries.at(-1)!.factId) : null }
}

export interface DrillDeps {
  reader: MetricsReader
  reports?: DrillReports
}

function metricOf(snapshot: ProcessMetrics, metric: MetricId, label: string) {
  const value = snapshot.metrics.find(m => m.id === metric)
  if (!value) throw new Error(`${label} has no metric ${metric}.`)
  return value
}

/** Reads one drill page for `teamId` (the caller's team, decided by its session). */
export function readDrillPage(deps: DrillDeps, teamId: string, request: DrillRequest): DrillPage {
  let cursor: DrillCursor
  let prior: DrillCursor | null = null
  if (request.cursor !== undefined) {
    const others = Object.entries(request).filter(([key, value]) => key !== 'cursor' && value !== undefined).map(([key]) => key)
    if (others.length) throw new Error(`A cursor carries its request: send { cursor } alone, without ${others.join(', ')}.`)
    prior = decodeDrillCursor(request.cursor)
    if (prior.team !== teamId) throw new Error('Drill cursor team mismatch: a cursor is read only by the team it was issued to.')
    cursor = prior
  } else {
    if (request.metric === undefined || request.list === undefined) throw new Error('A first page names metric and list (or pass a cursor).')
    const { metric, list } = checkMetricList(request.metric, request.list)
    const limit = checkLimit(list, request.limit)
    let src: Source
    if (request.report_id !== undefined) {
      if (request.window !== undefined || request.slice != null || request.end !== undefined) {
        throw new Error('A report drill takes report_id alone: no window, slice, or end.')
      }
      src = { kind: 'report', reportId: request.report_id }
    } else {
      if (request.window === undefined) throw new Error(`Name a window (${METRIC_WINDOWS.join(', ')}) or a report_id.`)
      if (!isMetricWindow(request.window)) throw new Error(`Unknown window "${request.window}". Allowed windows: ${METRIC_WINDOWS.join(', ')}.`)
      const now = deps.reader.clock()
      if (request.end !== undefined && (!iso(request.end) || Date.parse(request.end) > now)) {
        throw new Error('end must be an ISO instant (e.g. 2026-10-16T12:00:00.000Z) no later than now; pass the compact read\'s periodEnd.')
      }
      src = { kind: 'live', window: request.window, slice: request.slice ?? null, end: request.end ?? new Date(now).toISOString() }
    }
    cursor = { v: 1, team: teamId, src, metric, list, limit, after: '' }
  }
  const { src, metric, list, limit } = cursor
  const after = prior ? prior.after : null
  const next = (last: string | null, tool?: string) => last === null ? null
    : encode({ v: 1, team: teamId, src, metric, list, limit, after: last, ...(tool !== undefined ? { tool } : {}) })

  if (src.kind === 'report') {
    const report = deps.reports?.report(teamId, src.reportId)
    if (!report) throw new Error(`Unknown report: ${src.reportId}`)
    const value = metricOf(report.snapshot, metric, `Report ${src.reportId}`)
    const source = { kind: 'report' as const, reportId: src.reportId }
    if (list === 'toolStreaks') {
      const stored = value.drill.toolStreaks?.entries ?? []
      const page = storedStreakPage(stored, after, limit)
      return { metric, list, total: value.drill.toolStreaks?.total ?? 0, reachable: stored.length, entries: page.entries, next: next(page.last), source }
    }
    const page = idPage(value.drill[list], after, limit)
    return { metric, list, total: page.total, entries: page.entries, next: next(page.last), source }
  }

  const end = Date.parse(src.end)
  const source = { kind: 'live' as const, window: src.window, end: src.end }
  if (list === 'toolStreaks') {
    const page = deps.reader.toolDrill(teamId, src.window, src.slice, limit, prior?.tool ?? null, end)
    const last = page.nextCursor ? String(page.entries.at(-1)!.factId) : null
    return { metric, list, total: page.total, entries: page.entries, next: next(last, page.nextCursor ?? undefined), source }
  }
  const value = metricOf(deps.reader.readAt(teamId, src.window, src.slice, end), metric, 'This read')
  const page = idPage(value.drill[list], after, limit)
  return { metric, list, total: page.total, entries: page.entries, next: next(page.last), source }
}
