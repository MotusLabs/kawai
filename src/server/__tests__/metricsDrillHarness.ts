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
// `chat-other` to OTHER.
import { afterEach } from 'bun:test'
import { unknownToolMeasurement, type ToolMeasurementStatus } from '../../shared/processMetrics'
import { MetricsReader } from '../metrics/computeMetrics'
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
  /** Claude first, then Codex. */
  runtimes: ReadonlyArray<{ runtime: 'Claude' | 'Codex'; call: ToolCall }>
  /** The table handler with the runtimes' JSON round trip (fast seam for properties). */
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
      runtimes: [{ runtime: 'Claude', call: viaClaude }, { runtime: 'Codex', call: viaCodex }],
      streak(i, at, resolution = 'abandoned', team = TEAM) {
        const closedAt = new Date(at).toISOString()
        store.record({ kind: 'tool_streak', sourceKey: `streak-${team}-${i}`, teamId: team, sessionId: `session-${i}`,
          turnId: `turn-${i}`, toolCallId: `call-${i}`, observedAt: closedAt,
          data: { tool: 'Bash', toolKind: 'builtin', label: 'Bash', length: i % 7 + 1, resolution,
            firstAt: new Date(at - 500).toISOString(), closedAt } })
      },
      rows() {
        return JSON.stringify(['process_reports', 'process_proposals', 'process_observations'].map(table =>
          seed.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
      },
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
