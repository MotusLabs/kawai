// Seeded properties of agent metric reads (bounded-metrics-reads, design
// "Acceptance oracles"). P1, paging is exactly-once: over drill lists of
// 0–3,000 unique ids (limits 1–200) from a live source at a fixed fake clock
// and from a stored report, and over 0–300 tool streaks (limits 1–50),
// following `next` through the production `team_metrics_drill` handler of
// `teamToolTable` returns the generated rows whole, once, in order (ids in
// code-unit order; streaks newest closed first), and every page states the
// same total. P2, the compact form is a projection: over `metricsSeed`
// inputs, compact keeps every value, `n`, baseline, and flag, each kept list
// is a prefix of the full one with `<key>Total` its full length, the input is
// unchanged (the paged reader's cached read included), and the drill pages'
// union is the full list's entries, whole, in id order.
import { expect, test } from 'bun:test'
import type { MetricSlice, MetricValue, MetricWindow, ProcessMetrics } from '../../shared/processMetrics'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { readDrillPage } from '../metrics/metricsDrill'
import { compactMetrics } from '../metrics/metricsProjection'
import { propertyCases } from './helpers/propertyCases'
import { END, Seed, TEAM } from './metricsSeed'
import { useMetricsTools, type MetricsToolFixture } from './metricsDrillHarness'
import { mulberry32 } from './taskJournalFixture'

const make = useMetricsTools()
const DRILL = 'team_metrics_drill'
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const ALPHABET = 'aZ09-_éxQ'

/** `n` unique ids over a mixed alphabet, so code-unit order differs from locale order. */
function uniqueIds(rand: () => number, n: number, prefix: string): string[] {
  const out = new Set<string>()
  while (out.size < n) {
    let id = prefix
    for (let i = 0, len = 1 + Math.floor(rand() * 6); i < len; i++) id += ALPHABET[Math.floor(rand() * ALPHABET.length)]
    out.add(id + out.size.toString(36))
  }
  return [...out]
}

/** Follows `next` from `first` to null through the table handler; fails on a non-terminating walk. */
async function walk(f: MetricsToolFixture, first: unknown, bound: number) {
  let outcome = await f.table('chat-lead', DRILL, first)
  const entries: unknown[] = [], totals = new Set<number>()
  for (let pages = 1; ; pages++) {
    if (outcome.error !== null) throw new Error(outcome.error)
    totals.add(outcome.value.total)
    entries.push(...outcome.value.entries)
    if (outcome.value.next === null) break
    if (pages > bound) throw new Error(`walk did not end within ${bound} pages`)
    outcome = await f.table('chat-lead', DRILL, { cursor: outcome.value.next })
  }
  return { entries, totals: [...totals] }
}

test('P1: following next from the first page returns every live, report, and tool-streak drill entry exactly once with one total (seed 0xD811, 300 cases)', async () => {
  const CASES = 300
  const rand = mulberry32(0xD811)
  for (let c = 0; c < propertyCases(CASES); c++) {
    const kind = (['live', 'report', 'toolStreaks'] as const)[Math.floor(rand() * 3)]!
    const f = make()
    try {
      if (kind === 'toolStreaks') {
        const n = Math.floor(rand() * 301), limit = 1 + Math.floor(rand() * 50)
        const closed = Array.from({ length: n }, () => END - (1 + Math.floor(rand() * (n / 2 + 1))) * 60_000)
        f.seed.db.transaction(() => { closed.forEach((at, i) => f.streak(i, at)) })()
        // The generated cohort, independently: each streak as the harness wrote
        // it, its fact id the observation's seq, newest closed first (ties: higher fact id first).
        const seqs = new Map((f.seed.db.prepare('SELECT seq, source_key FROM process_observations').all() as Array<{ seq: number; source_key: string }>)
          .map(row => [row.source_key, row.seq]))
        const cohort = closed.map((at, i) => ({ factId: seqs.get(`streak-${TEAM}-${i}`)!, tool: 'Bash', length: i % 7 + 1, sessionId: `session-${i}`,
          turnId: `turn-${i}`, firstCallId: `call-${i}`, firstAt: new Date(at - 500).toISOString(), closedAt: new Date(at).toISOString() }))
          .sort((a, b) => (b.closedAt < a.closedAt ? -1 : b.closedAt > a.closedAt ? 1 : b.factId - a.factId))
        const { entries, totals } = await walk(f, { window: '7d', end: new Date(END).toISOString(), metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit }, n / limit + 2)
        expect(totals, `case ${c}`).toEqual([n])
        expect(entries, `case ${c}`).toEqual(cohort)
        continue
      }
      const list = rand() < 0.5 ? 'tasks' : 'messages'
      const n = Math.floor(rand() * 3001), limit = 1 + Math.floor(rand() * 200)
      const ids = uniqueIds(rand, n, list === 'tasks' ? 't' : 'm')
      f.seed.db.transaction(() => {
        for (const id of ids) {
          if (list === 'tasks') { f.seed.task(id, 72); f.seed.status(id, 'active', 'done', 24) }
          else f.seed.message({ id, createdHoursAgo: 1 + Math.floor(rand() * 100) })
        }
      })()
      const metric = list === 'tasks' ? 'lead_time_p50' : 'mail_share'
      let source: Record<string, unknown> = { window: '7d', end: new Date(END).toISOString() }
      if (kind === 'report') {
        const report = await f.table('chat-lead', 'process_report_submit', { window: '7d', summary: 'Weekly.' })
        source = { report_id: report.value.id }
      }
      const { entries, totals } = await walk(f, { ...source, metric, list, limit }, n / limit + 2)
      expect(totals, `case ${c}`).toEqual([n])
      // The generated rows, whole: a task's title is its id, a message is its own thread.
      expect(entries, `case ${c}`).toEqual([...ids].sort(codeUnit).map(id => (list === 'tasks' ? { id, title: id } : { id, threadId: id })))
    } finally { f.close() }
  }
}, 600_000)

const WINDOWS: MetricWindow[] = ['1d', '3d', '7d']
const SLICES: Array<MetricSlice | null> = [null, { kind: 'group' }, { kind: 'profile' }]
/** Every value, n, baseline, and flag of a metric. */
const numerics = ({ id, value, n, insufficient, baseline, approximate, partial, notSliceable, toolCoverage }: MetricValue) =>
  ({ id, value, n, insufficient, baseline, approximate, partial, notSliceable, toolCoverage })

/** A seeded team: tasks done and open (some with long titles), results, findings, mail, and starts. */
function seedInputs(rand: () => number): Seed {
  const s = new Seed()
  const groups = ['lead', 'devs', 'reviewers']
  s.db.transaction(() => {
    for (let i = 0, n = Math.floor(rand() * 4); i < n; i++) s.start(`chat-${i}`, 150, { group: groups[i % 3]!, profile: `p${i % 2}` })
    for (let i = 0, n = Math.floor(rand() * 160); i < n; i++) {
      const id = `task-${i}${rand() < 0.3 ? 'x'.repeat(200 + Math.floor(rand() * 400)) : ''}`
      s.task(id, 1 + rand() * 300)
      if (rand() < 0.7) s.status(id, 'active', 'done', rand() * 200)
      if (rand() < 0.4) {
        const result = s.result(id, `chat-${i % 4}`, rand() * 100, rand() < 0.5 ? { acceptedHoursAgo: rand() * 50 } : {})
        if (rand() < 0.5) s.finding(id, result, `chat-${(i + 1) % 4}`, rand() < 0.5 ? 'pass' : 'fail', rand() * 50)
      }
    }
    for (let i = 0, n = Math.floor(rand() * 400); i < n; i++) {
      const created = 1 + rand() * 300
      s.message({ id: `msg-${i}`, createdHoursAgo: created, ...(rand() < 0.6 ? { deliveredHoursAgo: created * rand() } : {}),
        fromGroup: groups[i % 3], priority: rand() < 0.2 ? 'urgent' : 'normal' })
      if (rand() < 0.05) s.event(`msg-${i}`, 'parked', created * rand())
    }
  })()
  return s
}

/** Checks one compact list against its full list: a prefix, with its total when shortened. */
function checkList(owner: Record<string, unknown>, full: Record<string, unknown>, key: string, label: string) {
  const kept = owner[key] as unknown[] | undefined, whole = full[key] as unknown[] | undefined
  if (!whole) { expect(kept, label).toBeUndefined(); return }
  expect(whole.slice(0, kept!.length), label).toEqual(kept!)
  if (kept!.length < whole.length && key !== 'entries') expect(owner[`${key}Total`], label).toBe(whole.length)
  else if (key !== 'entries') expect([undefined, whole.length] as unknown[], label).toContain(owner[`${key}Total`])
}

test('P2: compact keeps every value, n, baseline, and flag, keeps list prefixes with their totals, mutates nothing, and pages to the full lists (seed 0xC0DE, 300 cases)', () => {
  const CASES = 300
  const rand = mulberry32(0xC0DE)
  for (let c = 0; c < propertyCases(CASES); c++) {
    const s = seedInputs(rand)
    try {
      const window = WINDOWS[Math.floor(rand() * 3)]!, slice = SLICES[Math.floor(rand() * 3)]!
      const full: ProcessMetrics = readMetrics(s.db, TEAM, window, slice, END)
      const before = structuredClone(full)
      const compact = compactMetrics(full)
      expect(full, `case ${c} input unchanged`).toEqual(before)
      expect(new TextEncoder().encode(JSON.stringify(compact)).length, `case ${c}`).toBeLessThan(32000)
      expect(compact.metrics.map(numerics), `case ${c}`).toEqual(full.metrics.map(numerics))
      full.metrics.forEach((metric, i) => {
        const kept = compact.metrics[i]!, label = `case ${c} ${metric.id}`
        checkList(kept.drill as never, metric.drill as never, 'tasks', label)
        checkList(kept.drill as never, metric.drill as never, 'messages', label)
        checkList(kept as never, metric as never, 'breakdown', label)
        checkList(kept as never, metric as never, 'slices', label)
        if (metric.drill.toolStreaks) checkList(kept.drill.toolStreaks as never, metric.drill.toolStreaks as never, 'entries', label)
      })
      // The drill pages' union is each full list, whole entries, in id order;
      // the cached read being paged and its compact projection change nothing in it.
      const reader = new MetricsReader(s.db, () => END)
      const paged = reader.readAt(TEAM, window, slice, END)
      const pagedBefore = structuredClone(paged)
      expect(compactMetrics(paged).metrics.map(numerics), `case ${c}`).toEqual(full.metrics.map(numerics))
      for (const metric of full.metrics) {
        for (const list of ['tasks', 'messages'] as const) {
          const seen: unknown[] = []
          let page = readDrillPage({ reader }, TEAM, { window, ...(slice ? { slice } : {}), end: new Date(END).toISOString(), metric: metric.id, list, limit: 200 })
          for (;;) {
            seen.push(...page.entries)
            if (!page.next) break
            page = readDrillPage({ reader }, TEAM, { cursor: page.next })
          }
          expect(seen, `case ${c} ${metric.id} ${list}`).toEqual([...metric.drill[list]].sort((a, b) => codeUnit(a.id, b.id)))
        }
      }
      expect(full, `case ${c} input unchanged after paging`).toEqual(before)
      expect(paged, `case ${c} paged cache unchanged`).toEqual(pagedBefore)
      expect(reader.readAt(TEAM, window, slice, END), `case ${c} cache still serves the same read`).toEqual(pagedBefore)
    } finally { s.db.close() }
  }
}, 600_000)
