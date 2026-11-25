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
import {
  MAIL_SHARE_MESSAGES, OTHER, STREAKS, T17_ANCIENT_ENDS, T17_ENDS, T17_REFUSED_ENDS, big, noMutation, t12Variants, useMetricsTools,
  type MetricsToolFixture,
} from './metricsDrillHarness'

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

type Read = { label: string; session?: string; name: string; args: Record<string, unknown>; refused?: string; walk?: boolean }
const iso = (ms: number) => new Date(ms).toISOString()
const cursorOf = (raw: string) => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Every read-only call of Table T and its variants (refusals included), on
 * report `id` and `theirs` (another team's): a walk follows `next` to null,
 * and every call's outcome is asserted, never discarded.
 */
function tableReads(id: string, theirs: string, cursors: { live: string; streaks: string }): Read[] {
  const live = { window: '7d', metric: 'mail_share', list: 'messages' }
  const streaks = { window: '7d', end: iso(END), metric: 'tool_abandoned_streaks', list: 'toolStreaks' }
  const rawStreaks = cursorOf(cursors.streaks)
  return [
    { label: 'T1 compact', name: 'team_metrics', args: { window: '7d' } },
    { label: 'T1a full', name: 'team_metrics', args: { window: '7d', detail: 'full' } },
    { label: 'T4 sliced compact', name: 'team_metrics', args: { window: '7d', slice: { kind: 'group' } } },
    { label: 'T4 sliced full', name: 'team_metrics', args: { window: '7d', detail: 'full', slice: { kind: 'group' } } },
    { label: 'unknown window', name: 'team_metrics', args: { window: '30d' }, refused: 'Allowed windows' },
    { label: 'team-less session', session: 'chat-nobody', name: 'team_metrics', args: { window: '7d' }, refused: 'no team' },
    { label: 'T2 live messages walk', name: DRILL, args: { ...live, end: iso(END), limit: 200 }, walk: true },
    { label: 'T3 velocity', name: DRILL, args: { window: '7d', metric: 'velocity', list: 'tasks' }, refused: 'Allowed metrics' },
    { label: 'T3 toolStreaks on mail_share', name: DRILL, args: { window: '7d', metric: 'mail_share', list: 'toolStreaks' }, refused: 'Metrics with tool streaks' },
    { label: 'T3 breakdown', name: DRILL, args: { window: '7d', metric: 'mail_share', list: 'breakdown' }, refused: 'Allowed lists' },
    { label: 'T4 sliced drill walk', name: DRILL, args: { window: '7d', slice: { kind: 'group' }, metric: 'task_mail_per_task', list: 'messages', limit: 200 }, walk: true },
    { label: 'T4 slice x', name: DRILL, args: { ...live, slice: { kind: 'x' } }, refused: 'Allowed: group' },
    { label: 'T5 tasks walk', name: DRILL, args: { window: '7d', metric: 'lead_time_p50', list: 'tasks', limit: 200 }, walk: true },
    { label: 'T9 earlier end', name: DRILL, args: { ...live, end: iso(END - 31_000), limit: 200 } },
    { label: 'T11 limit 0', name: DRILL, args: { ...live, limit: 0 }, refused: '1–200' },
    { label: 'T11 limit 201', name: DRILL, args: { ...live, limit: 201 }, refused: '1–200' },
    { label: 'T11 limit 1.5', name: DRILL, args: { ...live, limit: 1.5 }, refused: '1–200' },
    { label: 'T11 streak limit 51', name: DRILL, args: { ...streaks, limit: 51 }, refused: '1–50' },
    { label: 'T12a streak ends differ', name: DRILL, args: { cursor: encode({ ...rawStreaks, src: { ...rawStreaks.src, end: iso(END - 1000) } }) }, refused: 'Invalid drill cursor' },
    { label: 'T13 their report get', name: 'process_report_get', args: { report_id: theirs }, refused: `Unknown report: ${theirs}` },
    { label: 'T13 their report full', name: 'process_report_get', args: { report_id: theirs, detail: 'full' }, refused: `Unknown report: ${theirs}` },
    { label: 'T13 their report drill', name: DRILL, args: { report_id: theirs, metric: 'mail_share', list: 'messages' }, refused: `Unknown report: ${theirs}` },
    { label: 'T13 unknown report', name: DRILL, args: { report_id: 'report-missing', metric: 'mail_share', list: 'messages' }, refused: 'Unknown report: report-missing' },
    { label: 'T14 foreign team cursor', session: 'chat-other', name: DRILL, args: { cursor: cursors.live }, refused: 'team mismatch' },
    { label: 'T15 live streaks walk', name: DRILL, args: { ...streaks, limit: 50 }, walk: true },
    { label: 'T16 report streaks walk', name: DRILL, args: { report_id: id, metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 20 }, walk: true },
    { label: 'report messages walk', name: DRILL, args: { report_id: id, metric: 'mail_share', list: 'messages', limit: 200 }, walk: true },
    { label: 'T6 list', name: 'process_reports_list', args: { limit: 10 } },
    { label: 'T7 get compact', name: 'process_report_get', args: { report_id: id } },
    { label: 'T7 get full', name: 'process_report_get', args: { report_id: id, detail: 'full' } },
    // Rows T12 and T17 whole, from the inputs those rows use, so a variant added there is checked here too.
    ...t12Variants(cursors.live).map(([args, refused], i): Read => ({ label: `T12 variant ${i}`, name: DRILL, args, refused })),
    ...T17_REFUSED_ENDS.map((end): Read => ({ label: `T17 refused ${end}`, name: DRILL, args: { ...live, end }, refused: 'end must be an ISO instant' })),
    ...[...T17_ENDS, ...T17_ANCIENT_ENDS].map(([end]): Read => ({ label: `T17 end ${end}`, name: DRILL, args: { ...live, end, limit: 5 } })),
  ]
}

/**
 * Runs every Table T read through both runtimes, asserting each call's
 * outcome; `afterEach(label)` runs after every call (each page of a walk).
 */
async function agentReads(f: MetricsToolFixture, id: string, afterEach: (label: string) => void = () => {}): Promise<number> {
  const theirs = f.service.list(OTHER).reports[0]!.id
  let reads = 0
  for (const { runtime, call } of f.runtimes) {
    const live = await call('chat-lead', DRILL, { window: '7d', end: iso(END), metric: 'mail_share', list: 'messages', limit: 10 })
    const streaks = await call('chat-lead', DRILL, { window: '7d', end: iso(END), metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 10 })
    afterEach(`${runtime} cursors`)
    for (const read of tableReads(id, theirs, { live: live.value.next, streaks: streaks.value.next })) {
      reads++
      const label = `${runtime} ${read.label}`
      let outcome = await call(read.session ?? 'chat-lead', read.name, read.args)
      afterEach(label)
      if (read.refused) {
        expect([outcome.value, outcome.error?.includes(read.refused)], label).toEqual([null, true])
        continue
      }
      expect(outcome.error, label).toBeNull()
      for (let pages = 1; read.walk && outcome.value.next !== null; pages++) {
        if (pages > 20) throw new Error(`${label}: the walk did not end`)
        outcome = await call('chat-lead', DRILL, { cursor: outcome.value.next })
        afterEach(`${label} page ${pages + 1}`)
        expect(outcome.error, `${label} page ${pages + 1}`).toBeNull()
      }
    }
  }
  return reads / f.runtimes.length
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
    // An agent's compact read first, in the same cache period as the tab's.
    for (const { runtime, call } of f.runtimes) {
      const compact = await call('chat-lead', 'team_metrics', { window: '7d' })
      expect(compact.value.projectionTruncated, runtime).toBe(true)
    }
    const before = []
    for (const request of requests) before.push(await t.send(request))
    // The tab's snapshot is whole: every metric, drill, breakdown, and slice row of the read, unmarked.
    const whole = roundTrip(readMetrics(f.seed.db, TEAM, '7d', null, END))
    expect(before[2].type).toBe('process-metrics-snapshot')
    expect(before[2].metrics.metrics).toEqual(whole.metrics)
    expect(before[2].metrics.projectionTruncated).toBeUndefined()
    const mail = before[2].metrics.metrics.find((m: { id: string }) => m.id === 'mail_share')
    expect(mail.drill.messages).toHaveLength(MAIL_SHARE_MESSAGES)
    expect(mail.drill.messagesTotal).toBeUndefined()
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

// @covers: process-reports › Agents read report snapshots compactly › Stored snapshot unchanged
test('P4: every read-only Table T call and refusal leaves every stored report and observation row byte-identical and the cached read unchanged; a submission adds a whole report and changes no existing row', async () => {
  const f = make()
  try {
    big(f)
    const [id] = reports(f)
    const before = f.rows()
    // The read the tab and agents share, cached at END: no agent read may change it.
    const cached = f.reader.read(TEAM, '7d', null)
    const cachedBefore = structuredClone(cached)
    const check = noMutation(f, cached)
    let calls = 0
    const reads = await agentReads(f, id!, label => {
      calls++
      check(label)
    })
    // Per runtime: the cursor setup, 30 reads, T12's 15 and T17's 20 variants,
    // and the later pages of the six walks (T2 12, sliced 4, T5 1, T15 2,
    // T16 2, report messages 12).
    expect(reads).toBe(30 + 15 + 20)
    expect(calls).toBe(2 * (1 + reads + 33))
    expect(f.reader.read(TEAM, '7d', null)).toEqual(cachedBefore)
    const prior = JSON.parse(before) as unknown[][]
    const submitted = await f.runtimes[0]!.call('chat-lead', 'process_report_submit', { window: '7d', summary: 'Weekly.' })
    const after = JSON.parse(f.rows()) as unknown[][]
    expect(after[0]!.slice(0, prior[0]!.length)).toEqual(prior[0]!)
    expect(after[0]).toHaveLength(prior[0]!.length + 1)
    expect([after[1], after[2]]).toEqual([prior[1], prior[2]])
    expect(messageRefs(f.service.store.report(TEAM, submitted.value.id)!.snapshot)).toBe(6998)
  } finally { f.close() }
})

// @covers: process-reports › Reports are listed with their freshness › Missed daily report
test('process_reports_list states the latest 1d report\'s age as 30 hours when none was submitted for 30 hours, as the tab does', async () => {
  const f = make()
  try {
    f.service.submit({ teamId: TEAM, sessionId: 'chat-lead', group: { id: 'lead', canReportProcess: true }, groupIds: new Set(['lead']) } as never,
      { window: '1d', summary: 'Daily.' })
    f.clock.now += 30 * 3600_000
    for (const { runtime, call } of f.runtimes) {
      const listed = await call('chat-lead', 'process_reports_list', {})
      expect(listed.value.freshness.find((x: { window: string }) => x.window === '1d').ageHours, runtime).toBe(30)
    }
    expect(f.service.list(TEAM).freshness.find(x => x.window === '1d')!.ageHours).toBe(30)
  } finally { f.close() }
})
