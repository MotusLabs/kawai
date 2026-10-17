// Attribution, slicing, and assembly (team-process-metrics D4): reviewer
// metrics split by each finding author's hash, author metrics by the task
// owner's hash with one owner per task (`mixed` marking later results from
// another version), sliced `n` summing to the unsliced `n`, team metrics
// marked not sliceable, pre-recording work in `unrecorded`, baselines from the
// preceding window, determinism, and the 30 s read cache.
import { expect, test } from 'bun:test'
import type { MetricId, ProcessMetrics } from '../../shared/processMetrics'
import { MetricsReader, computeMetrics, readMetrics } from '../metrics/computeMetrics'
import { loadMetricsInputs } from '../metrics/metricsQuery'
import { DAY, END, Seed, TEAM } from './metricsSeed'

const metric = (m: ProcessMetrics, id: MetricId) => m.metrics.find(v => v.id === id)!
const slices = (m: ProcessMetrics, id: MetricId) =>
  Object.fromEntries((metric(m, id).slices ?? []).map(r => [r.key, { value: r.value, n: r.n, mixed: r.mixed }]))

/** Dev A (hash ga) fails first; dev B (hash gb) passes second; a clean task under gb; reviewers under ra/rb. */
function seeded() {
  const s = new Seed()
  s.start('chat-a', 6 * 24, { id: 'st-a', groupFileHash: 'ga', memoryHash: 'm1' })
  s.start('chat-b', 6 * 24, { id: 'st-b', groupFileHash: 'gb', memoryHash: 'm2' })
  s.start('chat-ra', 6 * 24, { id: 'st-ra', group: 'reviewers', groupFileHash: 'ra' })
  s.start('chat-rb', 6 * 24, { id: 'st-rb', group: 'reviewers', groupFileHash: 'rb' })
  s.manifest('m1', { 'MEMORY.md': 'x' })
  s.manifest('m2', { 'MEMORY.md': 'y', 'extra.md': 'z' })

  s.task('shared', 5 * 24)
  const r1 = s.result('shared', 'chat-a', 4 * 24)
  s.finding('shared', r1, 'chat-ra', 'pass', 4 * 24 - 1)
  s.finding('shared', r1, 'chat-rb', 'fail', 4 * 24 - 2)
  const r2 = s.result('shared', 'chat-b', 3 * 24)
  s.finding('shared', r2, 'chat-ra', 'pass', 3 * 24 - 1)
  s.usage('chat-a', 4 * 24, 100, { taskId: 'shared', startId: 'st-a' })
  s.usage('chat-b', 3 * 24, 50, { taskId: 'shared', startId: 'st-b' })
  s.status('shared', 'active', 'done', 2 * 24)

  s.task('clean', 5 * 24)
  const r3 = s.result('clean', 'chat-b', 4 * 24)
  s.finding('clean', r3, 'chat-ra', 'pass', 4 * 24 - 1)
  s.status('clean', 'active', 'done', 2 * 24)

  s.task('legacy', 30 * 24)
  const r4 = s.result('legacy', 'chat-old', 9 * 24)
  s.finding('legacy', r4, 'chat-ra', 'fail', 2 * 24)
  s.status('legacy', 'active', 'done', 24)

  s.task('baseline', 12 * 24)
  s.status('baseline', 'active', 'done', 10 * 24)
  return s
}

const read = (s: Seed, slice: Parameters<typeof readMetrics>[3]) => readMetrics(s.db, TEAM, '7d', slice, END)

test('reviewer and author slices by group file hash; one owner per task with mixed; n sums', () => {
  const s = seeded()
  const m = read(s, { kind: 'groupFileHash' })
  expect(slices(m, 'finding_fail_rate')).toEqual({
    ra: { value: 0.25, n: 4, mixed: undefined }, rb: { value: 1, n: 1, mixed: undefined },
  })
  expect(slices(m, 'first_pass_yield')).toEqual({
    ga: { value: 0, n: 1, mixed: 1 }, gb: { value: 1, n: 1, mixed: 0 }, unrecorded: { value: 0, n: 1, mixed: 0 },
  })
  expect(slices(m, 'fix_iterations').ga).toEqual({ value: 1, n: 1, mixed: 1 })
  expect(slices(m, 'tokens_per_task').ga).toEqual({ value: 150, n: 1, mixed: 1 })
  for (const id of ['first_pass_yield', 'finding_fail_rate', 'fix_iterations', 'tokens_per_task'] as const) {
    expect((metric(m, id).slices ?? []).reduce((sum, r) => sum + r.n, 0)).toBe(metric(m, id).n)
  }
  s.db.close()
})

test('memory-file slices read the manifest; absent files form their own slice', () => {
  const s = seeded()
  const m = read(s, { kind: 'memoryFile', file: 'extra.md' })
  expect(Object.keys(slices(m, 'first_pass_yield')).sort()).toEqual(['absent', 'unrecorded', 'z'])
  s.db.close()
})

test('team metrics are not sliceable under a group slice; sender metrics slice by group only', () => {
  const s = seeded()
  const m = read(s, { kind: 'group' })
  expect(metric(m, 'lead_time_p50')).toMatchObject({ notSliceable: true })
  expect(metric(m, 'lead_time_p50').slices).toBeUndefined()
  expect(metric(m, 'mail_share').notSliceable).toBeUndefined()
  expect(metric(read(s, { kind: 'profile' }), 'mail_share').notSliceable).toBe(true)
  expect(metric(read(s, { kind: 'profile' }), 'limit_tax_hours').notSliceable).toBeUndefined()
  s.db.close()
})

test('baselines come from the preceding window; identical inputs give identical results', () => {
  const s = seeded()
  const m = read(s, null)
  expect(metric(m, 'lead_time_p50')).toMatchObject({ n: 3, baseline: { value: 2 * 24, n: 1, insufficient: true } })
  expect(m).toMatchObject({ periodEnd: new Date(END).toISOString(), baselineStart: new Date(END - 14 * DAY).toISOString(), minSample: 10 })
  const inputs = loadMetricsInputs(s.db, TEAM, END - 14 * DAY, END)
  expect(computeMetrics(inputs, '7d', null, END)).toEqual(computeMetrics(loadMetricsInputs(s.db, TEAM, END - 14 * DAY, END), '7d', null, END))
  s.db.close()
})

test('a read is cached per team, window, and slice for 30 s', () => {
  const s = seeded()
  let now = END
  const reader = new MetricsReader(s.db, () => now)
  const first = reader.read(TEAM, '7d', null)
  s.task('late', 2)
  s.status('late', 'active', 'done', 1)
  now += 29_000
  expect(reader.read(TEAM, '7d', null)).toBe(first)
  expect(reader.read(TEAM, '3d', null)).not.toBe(first)
  now += 1_000
  expect(metric(reader.read(TEAM, '7d', null), 'lead_time_p50').n).toBe(4)
  s.db.close()
})
