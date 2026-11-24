// Seeded properties of agent metric reads (bounded-metrics-reads, design
// "Acceptance oracles"). P1, paging is exactly-once: over drill lists of
// 0–3,000 unique ids (limits 1–200) from a live source at a fixed fake clock
// and from a stored report, and over 0–300 tool streaks (limits 1–50),
// following `next` through the production `team_metrics_drill` handler of
// `teamToolTable` returns the sorted list once and every page states the
// same total. P2, the compact form is a projection: over `metricsSeed`
// inputs, compact keeps every value, `n`, baseline, and flag, each kept list
// is a prefix of the full one with `<key>Total` its full length, the input is
// unchanged, and the drill pages' union is the full list in id order.
import { expect, test } from 'bun:test'
import type { MetricSlice, MetricValue, MetricWindow, ProcessMetrics } from '../../shared/processMetrics'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { readDrillPage } from '../metrics/metricsDrill'
import { compactMetrics } from '../metrics/metricsProjection'
import { closedOrder } from '../metrics/toolMetrics'
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
        f.seed.db.transaction(() => { for (let i = 0; i < n; i++) f.streak(i, END - (1 + Math.floor(rand() * (n / 2 + 1))) * 60_000) })()
        const expected = f.reader.toolDrill(TEAM, '7d', null, 50, null).total
        const { entries, totals } = await walk(f, { window: '7d', end: new Date(END).toISOString(), metric: 'tool_abandoned_streaks', list: 'toolStreaks', limit }, n / limit + 2)
        const facts = entries as Array<{ factId: number; closedAt: string }>
        expect(expected, `case ${c}`).toBe(n)
        expect(totals, `case ${c}`).toEqual([n])
        expect(facts.map(e => e.factId), `case ${c}`).toEqual([...facts].sort(closedOrder as never).map(e => e.factId))
        expect(new Set(facts.map(e => e.factId)).size, `case ${c}`).toBe(n)
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
      expect((entries as Array<{ id: string }>).map(e => e.id), `case ${c}`).toEqual([...ids].sort(codeUnit))
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
      // The drill pages' union is each full list in id order.
      const reader = new MetricsReader(s.db, () => END)
      for (const metric of full.metrics) {
        for (const list of ['tasks', 'messages'] as const) {
          const seen: string[] = []
          let page = readDrillPage({ reader }, TEAM, { window, ...(slice ? { slice } : {}), end: new Date(END).toISOString(), metric: metric.id, list, limit: 200 })
          for (;;) {
            seen.push(...page.entries.map(e => (e as { id: string }).id))
            if (!page.next) break
            page = readDrillPage({ reader }, TEAM, { cursor: page.next })
          }
          expect(seen, `case ${c} ${metric.id} ${list}`).toEqual(metric.drill[list].map(e => e.id).sort(codeUnit))
        }
      }
      expect(full, `case ${c} input unchanged after paging`).toEqual(before)
    } finally { s.db.close() }
  }
}, 600_000)
