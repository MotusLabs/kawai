// `team_metrics_drill` (bounded-metrics-reads D2/D3, design "Acceptance
// oracles" Table T): every row runs through `teamToolTable` as production
// composes it — a real MetricsReader, ObservationStore, and report service —
// under both runtimes' registrations (Claude team MCP server and Codex
// dynamic tools), on the seeded 300-task 7d fixture (`metricsDrillHarness`).
// Rows: T2 paging 2,595 messages to the end, T3 unknown metric/list, T4
// slices, T5 a short list, T9/T10 the end-keyed cache, T11 limits, T12
// cursors, T14 another team's cursor, T15 tool streaks under later commits,
// T17 `end`. Every refusal carries the tool-error envelope and no entries.
import { expect, test } from 'bun:test'
import { HOUR, TEAM } from './metricsSeed'
import { MAIL_SHARE_MESSAGES, STREAKS, big, useMetricsTools, type Outcome } from './metricsDrillHarness'

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
