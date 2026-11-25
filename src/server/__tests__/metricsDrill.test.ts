// `team_metrics_drill` (bounded-metrics-reads D2/D3, design "Acceptance
// oracles" Table T): every row runs through `teamToolTable` as production
// composes it — a real MetricsReader, ObservationStore, and report service —
// under both runtimes' registrations (Claude team MCP server and Codex
// dynamic tools), on the seeded 300-task 7d fixture (`metricsDrillHarness`).
// Rows: T2 paging 2,595 messages to the end, T3 unknown metric/list, T4
// slices, T5 a short list, T9/T10 the end-keyed cache, T11 limits, T12
// cursors, T12a a tool-streak cursor's two ends, T14 another team's cursor, T15 tool streaks under later commits,
// T17 `end`. Every refusal carries the tool-error envelope and no entries.
import { expect, test } from 'bun:test'
import { readMetrics } from '../metrics/computeMetrics'
import { END, HOUR, TEAM } from './metricsSeed'
import { MAIL_SHARE_MESSAGES, STREAKS, T17_ANCIENT_ENDS, T17_ENDS, T17_REFUSED_ENDS, big, noMutation, seedAncient, t12Variants, useMetricsTools, type Outcome } from './metricsDrillHarness'

const make = useMetricsTools()
const DRILL = 'team_metrics_drill'
const ids = (items: Array<{ id: string }>) => items.map(item => item.id)
const sortedIds = (items: Array<{ id: string }>) => ids(items).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const refused = (outcome: Outcome, reason: string) => {
  expect(outcome.value).toBeNull()
  expect(outcome.error).toContain(reason)
}
const cursorOf = (raw: string) => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

// @covers: team-process-metrics › Agents page metric drill lists › Paging a message list to the end
test('T2: drill mail_share messages at limit 200 walks 13 pages to a null cursor, each id once in order, every total 2,595', async () => {
  const f = make()
  try {
    big(f)
    const periodEnd = f.reader.read(TEAM, '7d', null).periodEnd
    const expected = sortedIds(f.reader.read(TEAM, '7d', null).metrics.find(m => m.id === 'mail_share')!.drill.messages)
    expect(expected).toHaveLength(MAIL_SHARE_MESSAGES)
    for (const { runtime, call } of f.runtimes) {
      let outcome = await call('chat-lead', DRILL, { window: '7d', end: periodEnd, metric: 'mail_share', list: 'messages', limit: 200 })
      const seen: string[] = []
      let pages = 0
      for (;;) {
        expect(outcome.error, runtime).toBeNull()
        const page = outcome.value
        pages++
        expect([page.metric, page.list, page.total, page.source], runtime)
          .toEqual(['mail_share', 'messages', MAIL_SHARE_MESSAGES, { kind: 'live', window: '7d', end: periodEnd }])
        expect(page.entries.length).toBeLessThanOrEqual(200)
        seen.push(...ids(page.entries))
        if (page.next === null) break
        outcome = await call('chat-lead', DRILL, { cursor: page.next })
      }
      expect(pages, runtime).toBe(13)
      expect(seen, runtime).toEqual(expected)
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Cursor bound to its request
test('T14: a live cursor used from a session of another team is refused as a team mismatch with no entries', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      const first = await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit: 10 })
      expect(first.error, runtime).toBeNull()
      const foreign = await call('chat-other', DRILL, { cursor: first.value.next })
      refused(foreign, 'team mismatch')
      // The same cursor still serves its own team.
      const own = await call('chat-dev', DRILL, { cursor: first.value.next })
      expect(own.error, runtime).toBeNull()
      expect(own.value.entries).toHaveLength(10)
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Unknown metric or list
test('T3: drill metric velocity, toolStreaks on mail_share, and list breakdown are refused naming the allowed values', async () => {
  const f = make()
  try {
    big(f)
    for (const { call } of f.runtimes) {
      refused(await call('chat-lead', DRILL, { window: '7d', metric: 'velocity', list: 'tasks' }), 'Allowed metrics: lead_time_p50, lead_time_p90,')
      refused(await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'toolStreaks' }), 'Metrics with tool streaks: tool_abandoned_streaks.')
      refused(await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'breakdown' }), 'Allowed lists: tasks, messages, toolStreaks.')
    }
  } finally { f.close() }
})

test('T4: a drill with slice group pages the sliced read\'s list; slice kind x is refused naming the kinds', async () => {
  const f = make()
  try {
    big(f)
    const sliced = f.reader.read(TEAM, '7d', { kind: 'group' })
    const expected = sortedIds(sliced.metrics.find(m => m.id === 'task_mail_per_task')!.drill.messages)
    for (const { runtime, call } of f.runtimes) {
      const first = await call('chat-lead', DRILL, { window: '7d', slice: { kind: 'group' }, end: sliced.periodEnd, metric: 'task_mail_per_task', list: 'messages', limit: 200 })
      expect(first.error, runtime).toBeNull()
      expect(cursorOf(first.value.next).src).toEqual({ kind: 'live', window: '7d', slice: { kind: 'group' }, end: sliced.periodEnd })
      const second = await call('chat-lead', DRILL, { cursor: first.value.next })
      expect([...ids(first.value.entries), ...ids(second.value.entries)].slice(0, 400)).toEqual(expected.slice(0, 400))
      refused(await call('chat-lead', DRILL, { window: '7d', slice: { kind: 'x' }, metric: 'mail_share', list: 'messages' }), 'Allowed: group, profile, groupFileHash, memoryFile.')
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Short list ends on its first page
test('T5: a drill on a metric with 12 task refs returns all 12, total 12, and a null cursor', async () => {
  const f = make()
  try {
    for (let i = 0; i < 12; i++) { f.seed.task(`short-${i}`, 72); f.seed.status(`short-${i}`, 'active', 'done', 24) }
    for (const { runtime, call } of f.runtimes) {
      const page = await call('chat-lead', DRILL, { window: '7d', metric: 'lead_time_p50', list: 'tasks' })
      expect(page.error, runtime).toBeNull()
      expect([page.value.total, page.value.entries.length, page.value.next]).toEqual([12, 12, null])
      expect(ids(page.value.entries)).toEqual(Array.from({ length: 12 }, (_, i) => `short-${i}`).sort())
    }
  } finally { f.close() }
})

test('T9: two drills whose end differ by 31 s each equal readAt at their own end', async () => {
  const f = make()
  try {
    big(f)
    f.seed.message({ id: 'msg-late', createdHoursAgo: 10 / 3600 })
    const early = new Date(END - 31_000).toISOString(), late = new Date(END).toISOString()
    for (const { runtime, call } of f.runtimes) {
      for (const end of [early, late]) {
        const page = await call('chat-lead', DRILL, { window: '7d', end, metric: 'mail_share', list: 'messages', limit: 200 })
        const expected = sortedIds(readMetrics(f.seed.db, TEAM, '7d', null, Date.parse(end)).metrics.find(m => m.id === 'mail_share')!.drill.messages)
        expect([page.value.total, ids(page.value.entries)], `${runtime} ${end}`).toEqual([expected.length, expected.slice(0, 200)])
      }
    }
    expect(f.reader.readAt(TEAM, '7d', null, END - 31_000).metrics.find(m => m.id === 'mail_share')!.drill.messages).toHaveLength(MAIL_SHARE_MESSAGES)
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Live pages keep their window end
test('T10: page 2 read 1 h after page 1, records unchanged, equals the read at the cursor\'s end, not at now', async () => {
  // One fixture per runtime, so each runtime's page 2 meets an expired cache entry.
  for (const index of [0, 1]) {
    const f = make()
    try {
      big(f)
      // At END this message is inside the 7d window; an hour later it is not.
      f.seed.message({ id: 'msg-edge', createdHoursAgo: 7 * 24 - 0.5 })
      const reference = readMetrics(f.seed.db, TEAM, '7d', null, END)
      const atEnd = sortedIds(reference.metrics.find(m => m.id === 'mail_share')!.drill.messages)
      expect(atEnd).toContain('msg-edge')
      const { runtime, call } = f.runtimes[index]!
      const before = noMutation(f)
      const first = await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit: 200 })
      before(`${runtime} page 1`)
      // I1: keep page 1's cached read (a hit at END, no refresh) across the hour; page 2
      // recomputes at the cursor's end through the expired cache and leaves both reads intact.
      const old = f.reader.readAt(TEAM, '7d', null, END)
      const check = noMutation(f, old)
      f.clock.now = END + HOUR
      const second = await call('chat-lead', DRILL, { cursor: first.value.next })
      check(`${runtime} page 2`)
      expect(second.value.source, runtime).toEqual({ kind: 'live', window: '7d', end: new Date(END).toISOString() })
      expect(second.value.total).toBe(atEnd.length)
      expect([...ids(first.value.entries), ...ids(second.value.entries)]).toEqual(atEnd.slice(0, 400))
      // The entry page 2 recomputed (read now as a hit, not a refresh) is the reference read at END.
      const recomputed = f.reader.readAt(TEAM, '7d', null, END)
      expect(recomputed.metrics, runtime).not.toBe(old.metrics)
      expect(recomputed.metrics, runtime).toEqual(reference.metrics)
      expect(old.metrics, runtime).toEqual(reference.metrics)
    } finally { f.close() }
  }
})

test('T11: limit 0, 201, and 1.5 on messages are refused naming 1–200; 51 on toolStreaks is refused naming 1–50', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      for (const limit of [0, 201, 1.5]) refused(await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit }), '1–200')
      refused(await call('chat-lead', DRILL, { window: '7d', metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 51 }), '1–50')
      // The boundaries themselves are allowed.
      expect((await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit: 200 })).value.entries, runtime).toHaveLength(200)
      expect((await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit: 1 })).value.entries).toHaveLength(1)
      expect((await call('chat-lead', DRILL, { window: '7d', metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 50 })).value.entries).toHaveLength(50)
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Cursor bound to its request
test('T12: a cursor not base64url, v 2, an unknown field, a missing after, or a cursor sent with metric is refused', async () => {
  const f = make()
  try {
    big(f)
    for (const { call } of f.runtimes) {
      const first = await call('chat-lead', DRILL, { window: '7d', metric: 'mail_share', list: 'messages', limit: 10 })
      const rows = t12Variants(first.value.next)
      for (const [args, reason] of rows) refused(await call('chat-lead', DRILL, args), reason)
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Cursor bound to its request
test('T12a: a live toolStreaks cursor whose end differs from its inner pager cursor\'s window end is refused with no entries', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      const first = await call('chat-lead', DRILL, { window: '7d', end: new Date(END).toISOString(), metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit: 10 })
      expect(first.error, runtime).toBeNull()
      const raw = cursorOf(first.value.next)
      // The untouched cursor serves; moving only the outer end (earlier, so not in the future) is refused.
      expect((await call('chat-lead', DRILL, { cursor: encode(raw) })).value.entries, runtime).toHaveLength(10)
      refused(await call('chat-lead', DRILL, { cursor: encode({ ...raw, src: { ...raw.src, end: new Date(END - 1000).toISOString() } }) }), 'Invalid drill cursor')
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents page metric drill lists › Tool streaks keep their high-water mark
test('T15: a live toolStreaks walk while three later streaks commit keeps the first page\'s high-water mark and equals the human pager\'s pages', async () => {
  // One fixture per runtime: a walk's later commits must not seed the next runtime's first page.
  for (const index of [0, 1]) {
    const f = make()
    try {
      big(f)
      const { runtime, call } = f.runtimes[index]!
      const walk = (cursor: string | null, out: number[] = []): number[] => {
        const page = f.reader.toolDrill(TEAM, '7d', null, 50, cursor)
        out.push(...page.entries.map(e => e.factId))
        return page.nextCursor ? walk(page.nextCursor, out) : out
      }
      const human = walk(null)
      expect(human).toHaveLength(STREAKS)
      // A streak closed after `end` but before the agent's now must not enter its walk.
      f.streak(900, END + 5 * 60_000)
      f.clock.now = END + 10 * 60_000
      let outcome = await call('chat-lead', DRILL, { window: '7d', end: new Date(END).toISOString(), metric: 'tool_abandoned_streaks', list: 'toolStreaks' })
      const seen: number[] = []
      for (let pages = 1; ; pages++) {
        expect(outcome.error, runtime).toBeNull()
        expect(outcome.value.total, runtime).toBe(STREAKS)
        seen.push(...outcome.value.entries.map((e: { factId: number }) => e.factId))
        if (pages === 1) for (let i = 0; i < 3; i++) f.streak(1000 + i, END - HOUR / 2)
        if (outcome.value.next === null) break
        outcome = await call('chat-lead', DRILL, { cursor: outcome.value.next })
      }
      expect(seen, runtime).toEqual(human)
    } finally { f.close() }
  }
})

test('T17: an end later than now or not an ISO instant is refused naming end; ISO instants without a fraction or with an offset are read at their instant', async () => {
  const f = make()
  try {
    big(f)
    // Years 0000–0099 keep their four digits (Date.UTC would read 0099 as 1999), including year 0's leap day;
    // two messages an hour before each end make a continuation whose source and cursor keep that end.
    seedAncient(f)
    for (const { runtime, call } of f.runtimes) {
      for (const end of T17_REFUSED_ENDS) {
        refused(await call('chat-lead', DRILL, { window: '7d', end, metric: 'mail_share', list: 'messages' }), 'end must be an ISO instant')
      }
      // Now itself, an offset form of an earlier instant, and a sub-second fraction.
      for (const [end, canonical] of T17_ENDS) {
        const page = await call('chat-lead', DRILL, { window: '7d', end, metric: 'mail_share', list: 'messages', limit: 5 })
        expect(page.error, `${runtime} ${end}`).toBeNull()
        expect(page.value.source).toEqual({ kind: 'live', window: '7d', end: canonical })
        expect(cursorOf(page.value.next).src.end).toBe(canonical)
        const expected = readMetrics(f.seed.db, TEAM, '7d', null, Date.parse(canonical)).metrics.find(m => m.id === 'mail_share')!.drill.messages
        expect(page.value.total).toBe(expected.length)
      }
      for (const [end, canonical] of T17_ANCIENT_ENDS) {
        const page = await call('chat-lead', DRILL, { window: '7d', end, metric: 'mail_share', list: 'messages', limit: 1 })
        expect(page.error, `${runtime} ${end}`).toBeNull()
        expect([page.value.source, page.value.total], `${runtime} ${end}`).toEqual([{ kind: 'live', window: '7d', end: canonical }, 2])
        expect(cursorOf(page.value.next).src.end).toBe(canonical)
        const second = await call('chat-lead', DRILL, { cursor: page.value.next })
        expect(second.error, `${runtime} ${end}`).toBeNull()
        expect([second.value.source, second.value.total, second.value.next], `${runtime} ${end}`).toEqual([{ kind: 'live', window: '7d', end: canonical }, 2, null])
        expect([...ids(page.value.entries), ...ids(second.value.entries)].sort()).toEqual([`msg-${canonical}-1`, `msg-${canonical}-2`])
      }
    }
    // The fixture's I1 witness checked every call, continuations included: 13 refusals, 4 ends, 3 two-page ends per runtime.
    expect(f.witnessed.calls).toBe(2 * (T17_REFUSED_ENDS.length + T17_ENDS.length + 2 * T17_ANCIENT_ENDS.length))
  } finally { f.close() }
})
