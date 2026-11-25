// The agent metrics and report tools as production composes them
// (bounded-metrics-reads, design "Acceptance oracles"): one real
// `MetricsReader` and `ProcessReportService` over a seeded database, given to
// `teamToolTable` in the `metrics`/`reports` service shape ChatSessionManager
// passes, and called through both runtimes' registrations — the Claude team
// MCP server's tools/call request path (its input validation included) and
// the Codex dynamic-tool dispatch — plus
// the table's own handler with the runtimes' `JSON.stringify` round trip for
// the seeded properties. `big()` seeds the 300-task 7d fixture whose
// `mail_share` list holds 2,595 messages and whose window holds 120
// abandoned tool streaks. Sessions `chat-lead` and `chat-dev` belong to TEAM,
// `chat-other` to OTHER. The T12 and T17 drill variants live here so T12,
// T17, and P4 share them; every read-tool call through either runtime runs
// inside the whole-reader I1 witness (`witness`, design property P4).
import { afterEach, expect } from 'bun:test'
import { unknownToolMeasurement, type MetricSlice, type MetricWindow, type ToolMeasurementStatus } from '../../shared/processMetrics'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { ObservationStore } from '../metrics/observations/store'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import type { GroupDefinition } from '../team/groupFile'
import { createMailboxServer, teamToolTable, type MailboxServerServices } from '../team/mailboxTools'
import type { TeamMailbox } from '../team/TeamMailbox'
import { CodexToolSessions } from './codexToolSession'
import { END, HOUR, Seed, TEAM } from './metricsSeed'

export const OTHER = '/other/.git'
export type Outcome = { error: string; value: null } | { error: null; value: any }
export type ToolCall = (sessionId: string, name: string, args: unknown) => Promise<Outcome>
type ToolResult = { isError?: boolean; content: Array<{ text: string }> }
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }>
type CallHandler = (request: { method: 'tools/call'; params: { name: string; arguments: unknown } }, extra: unknown) => Promise<ToolResult>

const TEAMS: Record<string, string> = { 'chat-lead': TEAM, 'chat-dev': TEAM, 'chat-other': OTHER }
const GROUPS = new Set(['lead', 'devs'])

export interface MetricsToolFixture {
  seed: Seed
  store: ObservationStore
  reader: MetricsReader
  service: ProcessReportService
  /** The fake clock every component reads. */
  clock: { now: number }
  /** The measurement status the reader overlays; replace `status` to change it. */
  measurement: { status: ToolMeasurementStatus }
  services: MailboxServerServices
  /** Claude first, then Codex; each read-tool call runs inside the I1 witness. */
  runtimes: ReadonlyArray<{ runtime: 'Claude' | 'Codex'; call: ToolCall }>
  /** Read-tool calls the I1 witness has checked. */
  witnessed: { calls: number }
  /** The table handler with the runtimes' JSON round trip (fast seam for properties; unwitnessed). */
  table: ToolCall
  /** One abandoned (or other) tool streak closed at `at`. */
  streak(i: number, at: number, resolution?: string, team?: string): void
  /** The stored report and observation rows, for no-mutation checks. */
  rows(): string
  close(): void
}

/** Registers the per-test cleanup of the Codex sessions and Claude servers; call once per test file. */
export function useMetricsTools(): () => MetricsToolFixture {
  const servers: Array<{ instance: { close: () => Promise<void> } }> = []
  let codex: CodexToolSessions | null = null
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.instance.close()))
    await codex?.closeAll()
    codex = null
  })
  return () => {
    const seed = new Seed()
    const clock = { now: END }
    const measurement = { status: unknownToolMeasurement() }
    const store = new ObservationStore(seed.db, () => clock.now)
    const reader = new MetricsReader(seed.db, () => clock.now, undefined, () => measurement.status)
    const service = new ProcessReportService(seed.db, reader, { now: () => clock.now })
    const callers: Record<string, ReportCaller> = Object.fromEntries(Object.entries(TEAMS).map(([sessionId, teamId]) => [sessionId, {
      teamId, sessionId, group: { id: 'lead', canReportProcess: true } as GroupDefinition, groupIds: GROUPS,
    }]))
    const services: MailboxServerServices = {
      metrics: { teamOf: id => TEAMS[id] ?? null, reader },
      reports: { caller: async id => callers[id] ?? null, service },
    }
    const mailbox = {} as TeamMailbox
    const rows = () => JSON.stringify(['process_reports', 'process_proposals', 'process_observations'].map(table =>
      seed.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
    const watch = witness(reader, seed.db, rows)
    // Every read-tool call through a runtime runs inside the witness; writes (process_report_submit) do not.
    const witnessed = (runtime: string, call: ToolCall): ToolCall => (sessionId, name, args) =>
      READ_TOOLS.has(name) ? watch.around(`${runtime} ${name} ${JSON.stringify(args)}`, () => call(sessionId, name, args)) : call(sessionId, name, args)
    const viaClaude: ToolCall = async (sessionId, name, args) => {
      const server = await createMailboxServer(mailbox, sessionId, services)
      servers.push(server as unknown as { instance: { close: () => Promise<void> } })
      const instance = server.instance as unknown as { _registeredTools: Registered; server: { _requestHandlers: Map<string, CallHandler> } }
      if (!instance._registeredTools[name]) throw new Error(`Claude registration lacks ${name}`)
      // The MCP server's own tools/call path: its input validation runs before the handler.
      const result = await instance.server._requestHandlers.get('tools/call')!({ method: 'tools/call', params: { name, arguments: args } }, {})
      const text = result.content[0]!.text
      return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) }
    }
    codex = new CodexToolSessions(sessionId => teamToolTable(mailbox, sessionId, services))
    const sessions = codex
    const viaCodex: ToolCall = async (sessionId, name, args) => {
      const answer = await sessions.call(sessionId, name, args)
      const item = answer.contentItems[0]!
      const text = item.type === 'inputText' ? item.text ?? '' : ''
      return answer.success ? { error: null, value: JSON.parse(text) } : { error: text, value: null }
    }
    const table: ToolCall = async (sessionId, name, args) => {
      const tool = teamToolTable(mailbox, sessionId, services).find(t => t.name === name)
      if (!tool) throw new Error(`teamToolTable lacks ${name}`)
      try { return { error: null, value: JSON.parse(JSON.stringify(await tool.handler(args))) } }
      catch (error) { return { error: error instanceof Error ? error.message : String(error), value: null } }
    }
    return {
      seed, store, reader, service, clock, measurement, services, table,
      runtimes: [{ runtime: 'Claude', call: witnessed('Claude', viaClaude) }, { runtime: 'Codex', call: witnessed('Codex', viaCodex) }],
      witnessed: watch.state,
      streak(i, at, resolution = 'abandoned', team = TEAM) {
        const closedAt = new Date(at).toISOString()
        store.record({ kind: 'tool_streak', sourceKey: `streak-${team}-${i}`, teamId: team, sessionId: `session-${i}`,
          turnId: `turn-${i}`, toolCallId: `call-${i}`, observedAt: closedAt,
          data: { tool: 'Bash', toolKind: 'builtin', label: 'Bash', length: i % 7 + 1, resolution,
            firstAt: new Date(at - 500).toISOString(), closedAt } })
      },
      rows,
      close() { seed.db.close() },
    }
  }
}

export const MAIL_SHARE_MESSAGES = 2595
export const TASKS = 300
export const STREAKS = 120

/**
 * The 300-task 7d fixture: every task done inside the window, 2,595 messages
 * created in it (1,000 on done tasks, 1,700 delivered, one parked: 6,998 message refs in all), and 120
 * abandoned tool streaks, plus a recovered streak and another team's.
 */
export function big(f: MetricsToolFixture): void {
  const { seed } = f
  seed.db.transaction(() => {
    for (let i = 0; i < TASKS; i++) {
      const id = `task-${String(i).padStart(3, '0')}`
      seed.task(id, 160)
      seed.status(id, 'active', 'done', 1 + (i % 150))
    }
    for (let i = 0; i < MAIL_SHARE_MESSAGES; i++) {
      const created = 2 + (i % 155)
      seed.message({
        id: `msg-${String(i).padStart(4, '0')}`, createdHoursAgo: created,
        ...(i < 1700 ? { deliveredHoursAgo: created - 1 } : {}),
        fromGroup: ['lead', 'devs', 'reviewers'][i % 3], taskId: i < 1000 ? `task-${String(i % TASKS).padStart(3, '0')}` : null,
      })
    }
    seed.event('msg-0000', 'parked', 3)
    for (let i = 0; i < STREAKS; i++) f.streak(i, END - (2 + i) * HOUR)
    f.streak(500, END - 5 * HOUR, 'recovered')
    f.streak(501, END - 5 * HOUR, 'abandoned', OTHER)
  })()
}

const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const decodeCursor = (raw: string) => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

/**
 * Row T12's refused requests, built from a live mail_share messages first
 * page's `next` read at END: each with the reason its refusal names.
 */
export function t12Variants(next: string): Array<[Record<string, unknown>, string]> {
  const raw = decodeCursor(next)
  const { after: _after, ...noAfter } = raw
  return [
    [{ cursor: '!not-base64url' }, 'Invalid drill cursor'],
    [{ cursor: encodeCursor({ ...raw, v: 2 }) }, 'Invalid drill cursor'],
    [{ cursor: encodeCursor({ ...raw, extra: 1 }) }, 'Invalid drill cursor'],
    [{ cursor: encodeCursor(noAfter) }, 'Invalid drill cursor'],
    [{ cursor: encodeCursor({ ...raw, src: { ...raw.src, slice: undefined, reportId: 'x' } }) }, 'Invalid drill cursor'],
    [{ cursor: encodeCursor({ ...raw, src: { ...raw.src, end: new Date(END + 1).toISOString() } }) }, 'Invalid drill cursor'],
    // Every first-page argument beside a cursor, and an unknown one.
    ...([['metric', 'mail_share'], ['list', 'messages'], ['limit', 20], ['window', '7d'], ['end', new Date(END).toISOString()],
      ['report_id', 'report-x'], ['slice', { kind: 'group' }]] as const)
      .map(([key, value]): [Record<string, unknown>, string] => [{ cursor: next, [key]: value }, 'A cursor carries its request']),
    [{ cursor: next, extra: true }, 'Unrecognized key'],
    [{ window: '7d', metric: 'mail_share', list: 'messages', fresh: true }, 'Unrecognized key'],
  ]
}

/** Row T17's ends refused at clock END: later than now, not an ISO instant, or out of calendar range. */
export const T17_REFUSED_ENDS = [new Date(END + 1).toISOString(), '2026-10-16T12:00:01Z', '2026-10-16T13:00:00+00:59', '2026-10-16',
  'yesterday', '2026-10-16T12:00Z', '2026-02-30T00:00:00Z', '2026-10-16T24:00:00Z', '2026-10-16T12:00:00', '2026-10-16T12:00:00+24:00',
  '0001-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '0099-02-29T12:00:00Z']
/** Row T17's accepted ends at clock END with their canonical instants: now itself, an offset form, and fractions. */
export const T17_ENDS = [['2026-10-16T12:00:00Z', '2026-10-16T12:00:00.000Z'], ['2026-10-16T13:59:59+02:00', '2026-10-16T11:59:59.000Z'],
  ['2026-10-16T11:59:59.5Z', '2026-10-16T11:59:59.500Z'], ['2026-10-16T07:29:59.123456-04:30', '2026-10-16T11:59:59.123Z']] as const
/** Row T17's years 0000–0099, which keep their four digits (Date.UTC reads 0099 as 1999), and year 0's leap day. */
export const T17_ANCIENT_ENDS = [['0099-10-16T12:00:00.000Z', '0099-10-16T12:00:00.000Z'], ['0099-10-16T13:00:00+01:00', '0099-10-16T12:00:00.000Z'],
  ['0000-02-29T12:00:00.000Z', '0000-02-29T12:00:00.000Z']] as const

/** Row T17's two messages an hour before each ancient end, so each end's read has a continuation. */
export function seedAncient(f: MetricsToolFixture): void {
  for (const canonical of new Set(T17_ANCIENT_ENDS.map(([, c]) => c))) {
    for (const n of [1, 2]) f.seed.message({ id: `msg-${canonical}-${n}`, createdHoursAgo: (END - Date.parse(canonical)) / HOUR + n / 60 })
  }
}

/**
 * The I1 witness (design property P4): captures the stored report and
 * observation rows and a clone of each given cached object now; each call
 * of the returned check asserts the rows are byte-identical and every
 * object still deep-equals its clone.
 */
export function noMutation(f: MetricsToolFixture, ...cached: unknown[]): (label: string) => void {
  const rows = f.rows()
  const clones = cached.map(value => structuredClone(value))
  return label => {
    expect(f.rows() === rows, `${label}: stored rows unchanged`).toBe(true)
    cached.forEach((value, i) => expect(value, `${label}: cached read ${i} unchanged`).toEqual(clones[i]))
  }
}

/** The agent read tools; every call of one through a runtime runs inside the I1 witness. */
export const READ_TOOLS = new Set(['team_metrics', 'team_metrics_drill', 'process_reports_list', 'process_report_get'])

/**
 * The whole-reader I1 witness (design property P4), side-effect free: it
 * reads the caches only through `MetricsReader.cachedEntries` and never
 * through `read`/`readAt`. Around each call it asserts the stored report,
 * proposal, and observation rows are byte-identical; every metrics object any
 * cache has held since the fixture began still deep-equals the clone taken
 * when it was first seen (in place, even after eviction or replacement); and
 * every entry the call added or replaced with a newly computed object equals
 * an independent `readMetrics` at the end its key names (a latest read: its
 * time).
 */
function witness(reader: MetricsReader, db: Seed['db'], rows: () => string) {
  const seen = new Map<object, unknown>()
  const arm = () => { for (const e of reader.cachedEntries()) if (!seen.has(e.metrics)) seen.set(e.metrics, structuredClone(e.metrics)) }
  const state = { calls: 0 }
  return {
    state,
    async around(label: string, run: () => Promise<Outcome>): Promise<Outcome> {
      arm()
      const before = rows()
      const held = new Map(reader.cachedEntries().map(e => [`${e.cache} ${e.key}`, e.metrics]))
      const outcome = await run()
      expect(rows() === before, `${label}: stored rows unchanged`).toBe(true)
      for (const [metrics, clone] of seen) {
        if (!Bun.deepEquals(metrics, clone, true)) expect(metrics, `${label}: a cached metrics object changed`).toEqual(clone as never)
      }
      for (const e of reader.cachedEntries()) {
        // An entry holding an object seen before (a latest read reusing its end's entry) was checked when computed.
        if (held.get(`${e.cache} ${e.key}`) === e.metrics || seen.has(e.metrics)) continue
        const [team, window, slice, end] = JSON.parse(e.key) as [string, MetricWindow, MetricSlice | null, number?]
        const expected = readMetrics(db, team, window, slice, e.cache === 'end' ? end! : e.at)
        if (!Bun.deepEquals(e.metrics, expected, true)) expect(e.metrics, `${label}: new ${e.cache} entry ${e.key}`).toEqual(expected)
      }
      state.calls++
      arm()
      return outcome
    },
  }
}
