// Agent report reads are bounded in the handlers (bounded-metrics-reads D4,
// design "Acceptance oracles"): Table T rows T6 (list without snapshots), T7
// (get compact by default, detail full whole), T8 (submit echoes a compact
// snapshot, the stored row stays whole), T13 (another team's or an unknown
// report), T16 (a report's tool streaks are the stored ones, `reachable`
// beside `total`), T18 (the human's pager and report connection unchanged),
// and property P4 (reads change no stored report or observation row). Every
// row runs through `teamToolTable` under both runtimes' registrations on the
// 300-task fixture (`metricsDrillHarness`).
import { expect, test } from 'bun:test'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { readMetrics } from '../metrics/computeMetrics'
import { END, TEAM } from './metricsSeed'
import { MAIL_SHARE_MESSAGES, OTHER, STREAKS, big, useMetricsTools, type MetricsToolFixture } from './metricsDrillHarness'

const make = useMetricsTools()
const DRILL = 'team_metrics_drill'
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const proposal = { kind: 'change', target_kind: 'group', target: 'devs', edit: 'Ask for tests first.', rationale: 'Fail rate rose.',
  expected: [{ metric: 'finding_fail_rate', direction: 'down' }] }
const messageRefs = (snapshot: { metrics: Array<{ drill: { messages: unknown[] } }> }) =>
  snapshot.metrics.reduce((n, metric) => n + metric.drill.messages.length, 0)
const sortById = (items: Array<{ id: string }>) => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Two 7d reports with a proposal each and a 1d report, submitted directly through the service. */
function reports(f: MetricsToolFixture): string[] {
  const caller = { teamId: TEAM, sessionId: 'chat-lead', group: { id: 'lead', canReportProcess: true }, groupIds: new Set(['lead', 'devs']) } as const
  const ids = [
    f.service.submit(caller as never, { window: '7d', summary: 'Week one.', proposals: [proposal] }).id,
    f.service.submit(caller as never, { window: '1d', summary: 'Daily.' }).id,
    f.service.submit(caller as never, { window: '7d', summary: 'Week two.', proposals: [proposal] }).id,
  ]
  f.service.submit({ ...caller, teamId: OTHER, sessionId: 'chat-other' } as never, { window: '7d', summary: 'Theirs.' })
  return ids
}

// @covers: process-reports › Reports are listed with their freshness › Listing without snapshots
test('T6: process_reports_list limit 10 carries no snapshot key; ids, summaries, proposals, and freshness equal the human list\'s', async () => {
  const f = make()
  try {
    big(f)
    reports(f)
    const human = roundTrip(f.service.list(TEAM, 10))
    for (const { runtime, call } of f.runtimes) {
      const listed = await call('chat-lead', 'process_reports_list', { limit: 10 })
      expect(listed.error, runtime).toBeNull()
      expect(listed.value.reports).toHaveLength(3)
      for (const report of listed.value.reports) expect(Object.keys(report)).not.toContain('snapshot')
      expect(listed.value).toEqual({ ...human, reports: human.reports.map(({ snapshot: _snapshot, ...rest }) => rest) })
      expect(listed.value.reports[0].proposals[0].kind).toBe('change')
    }
  } finally { f.close() }
})

// @covers: process-reports › Agents read report snapshots compactly › Reading a 7d report
// @covers: process-reports › Agents read report snapshots compactly › Full report snapshot
test('T7: process_report_get on a 7d report is compact under 32,000 bytes with the stored values; detail full equals readReport\'s value', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const stored = f.service.store.report(TEAM, id!)!.snapshot
    expect(messageRefs(stored)).toBe(6998)
    for (const { runtime, call } of f.runtimes) {
      const compact = await call('chat-lead', 'process_report_get', { report_id: id })
      expect(compact.error, runtime).toBeNull()
      expect(bytes(compact.value.snapshot)).toBeLessThan(32000)
      expect(compact.value.snapshot.projectionTruncated).toBe(true)
      expect(compact.value.snapshot.metrics.map((m: { id: string; value: unknown; n: number; baseline: unknown }) => [m.id, m.value, m.n, m.baseline]))
        .toEqual(roundTrip(stored.metrics.map(m => [m.id, m.value, m.n, m.baseline])))
      expect(compact.value.snapshot.metrics.find((m: { id: string }) => m.id === 'mail_share').drill.messagesTotal).toBe(MAIL_SHARE_MESSAGES)
      const full = await call('chat-lead', 'process_report_get', { report_id: id, detail: 'full' })
      expect(full.value).toEqual(roundTrip(f.service.report(TEAM, id!)))
      expect(messageRefs(full.value.snapshot)).toBe(6998)
    }
  } finally { f.close() }
})

// @covers: process-reports › Agents read report snapshots compactly › Submit echoes a compact snapshot
test('T8: process_report_submit 7d returns a compact snapshot while the stored row holds the whole one with 6,998 message refs', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      const submitted = await call('chat-lead', 'process_report_submit', { window: '7d', summary: 'Weekly.', proposals: [proposal] })
      expect(submitted.error, runtime).toBeNull()
      expect(bytes(submitted.value.snapshot)).toBeLessThan(32000)
      expect(submitted.value.snapshot.projectionTruncated).toBe(true)
      expect(submitted.value.proposals).toHaveLength(1)
      const stored = f.service.store.report(TEAM, submitted.value.id)!
      expect(messageRefs(stored.snapshot)).toBe(6998)
      expect(stored.snapshot.projectionTruncated).toBeUndefined()
      expect(roundTrip(stored.snapshot)).toEqual(roundTrip(readMetrics(f.seed.db, TEAM, '7d', null, END)))
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Another team's report
test('T13: a report_id of another team or an unknown one is refused as Unknown report by get and drill', async () => {
  const f = make()
  try {
    big(f)
    reports(f)
    const theirs = f.service.list(OTHER).reports[0]!.id
    for (const { call } of f.runtimes) {
      for (const id of [theirs, 'report-missing']) {
        for (const [name, args] of [['process_report_get', { report_id: id }], ['process_report_get', { report_id: id, detail: 'full' }],
          [DRILL, { report_id: id, metric: 'mail_share', list: 'messages' }]] as const) {
          const outcome = await call('chat-lead', name, args)
          expect([outcome.value, outcome.error]).toEqual([null, `Unknown report: ${id}`])
        }
      }
    }
  } finally { f.close() }
})

// @covers: process-reports › Agents read report snapshots compactly › Paging a report drill list
// @covers: process-reports › Agents read report snapshots compactly › Paging a report after new activity
test('Report drill source: a 7d report\'s mail_share messages page to the end once in id order, frozen while new mail arrives', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const expected = sortById(f.service.store.report(TEAM, id!)!.snapshot.metrics.find(m => m.id === 'mail_share')!.drill.messages).map(m => m.id)
    let n = 0
    for (const { runtime, call } of f.runtimes) {
      let outcome = await call('chat-lead', DRILL, { report_id: id, metric: 'mail_share', list: 'messages', limit: 200 })
      const seen: string[] = []
      for (let pages = 1; ; pages++) {
        expect(outcome.error, runtime).toBeNull()
        expect([outcome.value.total, outcome.value.source]).toEqual([MAIL_SHARE_MESSAGES, { kind: 'report', reportId: id }])
        seen.push(...outcome.value.entries.map((e: { id: string }) => e.id))
        if (pages === 1) f.seed.message({ id: `msg-new-${n++}`, createdHoursAgo: 1 })
        if (outcome.value.next === null) break
        outcome = await call('chat-lead', DRILL, { cursor: outcome.value.next })
      }
      expect(seen, runtime).toEqual(expected)
    }
  } finally { f.close() }
})

test('T16: report toolStreaks on a snapshot with total 120 and 50 stored pages the 50 stored, total 120, reachable 50, then a null cursor', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const stored = f.service.store.report(TEAM, id!)!.snapshot.metrics.find(m => m.id === 'tool_abandoned_streaks')!.drill.toolStreaks!
    expect([stored.total, stored.entries.length]).toEqual([STREAKS, 50])
    for (const { runtime, call } of f.runtimes) {
      let outcome = await call('chat-lead', DRILL, { report_id: id, metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 20 })
      const seen: unknown[] = [], sizes: number[] = []
      for (;;) {
        expect(outcome.error, runtime).toBeNull()
        expect([outcome.value.total, outcome.value.reachable]).toEqual([STREAKS, 50])
        seen.push(...outcome.value.entries); sizes.push(outcome.value.entries.length)
        if (outcome.value.next === null) break
        outcome = await call('chat-lead', DRILL, { cursor: outcome.value.next })
      }
      expect(sizes, runtime).toEqual([20, 20, 10])
      expect(seen).toEqual(roundTrip(stored.entries))
      const whole = await call('chat-lead', DRILL, { report_id: id, metric: 'tool_abandoned_streaks', list: 'toolStreaks' })
      expect([whole.value.entries.length, whole.value.next]).toEqual([50, null])
    }
  } finally { f.close() }
})

/** The tab's connection over the fixture's reader and report service, as the Metrics tab reaches them. */
function tab(f: MetricsToolFixture) {
  const manager = { whenRestored: () => Promise.resolve(), metrics: f.reader, reports: f.service,
    teamScopes: { resolve: async (path: string) => (path === '/repo' ? { teamId: TEAM } : null) } } as unknown as ChatSessionManager
  const wire = new ChatConnections(manager), messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  // The reply as JSON, read loosely: each row checks its own fields.
  const send = async (message: ClientMessage): Promise<any> => {
    await wire.handle(connection, message)
    return roundTrip(messages.at(-1))
  }
  return { send, close: () => wire.disconnect(connection) }
}

/** Every agent read of Table T over the fixture, through both runtimes. */
async function agentReads(f: MetricsToolFixture, id: string) {
  for (const { call } of f.runtimes) {
    for (const detail of ['compact', 'full']) await call('chat-lead', 'team_metrics', { window: '7d', detail })
    await call('chat-lead', 'process_reports_list', { limit: 10 })
    for (const detail of ['compact', 'full']) await call('chat-lead', 'process_report_get', { report_id: id, detail })
    for (const args of [{ window: '7d', metric: 'mail_share', list: 'messages' }, { report_id: id, metric: 'mail_share', list: 'messages' },
      { window: '7d', metric: 'tool_abandoned_streaks', list: 'toolStreaks' }, { report_id: id, metric: 'tool_abandoned_streaks', list: 'toolStreaks' }]) {
      const first = await call('chat-lead', DRILL, { ...args, ...(args.list === 'toolStreaks' ? { limit: 50 } : { limit: 200 }) })
      expect(first.error).toBeNull()
      await call('chat-lead', DRILL, { cursor: first.value.next })
    }
  }
}

// @covers: process-reports › Reports are listed with their freshness › Tab keeps whole snapshots
// @covers: process-reports › Agents read report snapshots compactly › Stored snapshot unchanged
test('T18: the human tool pager, report detail, and metrics snapshot answer identically before and after agent walks', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const t = tab(f)
    const requests: ClientMessage[] = [
      { type: 'process-tool-drill-page', teamPath: '/repo', window: '7d', slice: null, pageSize: 50, cursor: null },
      { type: 'process-report-open', teamPath: '/repo', reportId: id! },
      { type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null },
    ]
    const before = []
    for (const request of requests) before.push(await t.send(request))
    expect(before[1].report.snapshot).toEqual(roundTrip(f.service.report(TEAM, id!)!.snapshot))
    expect(messageRefs(before[1].report.snapshot)).toBe(6998)
    await agentReads(f, id!)
    const after = []
    for (const request of requests) after.push(await t.send(request))
    expect(after).toEqual(before)
    expect(after[2].reports.every((r: { snapshot: { metrics: unknown[] } }) => r.snapshot.metrics.length > 0)).toBe(true)
    t.close()
  } finally { f.close() }
})

test('P4: Table T agent reads leave every stored report and observation row byte-identical; a submission adds a whole report and changes no existing row', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const before = f.rows()
    await agentReads(f, id!)
    expect(f.rows()).toBe(before)
    const prior = JSON.parse(before) as unknown[][]
    const submitted = await f.runtimes[0]!.call('chat-lead', 'process_report_submit', { window: '7d', summary: 'Weekly.' })
    const after = JSON.parse(f.rows()) as unknown[][]
    expect(after[0]!.slice(0, prior[0]!.length)).toEqual(prior[0]!)
    expect(after[0]).toHaveLength(prior[0]!.length + 1)
    expect([after[1], after[2]]).toEqual([prior[1], prior[2]])
    expect(messageRefs(f.service.store.report(TEAM, submitted.value.id)!.snapshot)).toBe(6998)
  } finally { f.close() }
})
