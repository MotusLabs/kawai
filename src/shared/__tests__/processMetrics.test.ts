// The fixed metric set (team-process-metrics D4): every efficiency metric
// carries a guard that is itself a defined guard metric, ids are unique, each
// metric declares exactly one side, and the guard pairs are the spec's.
import { expect, test } from 'bun:test'
import {
  METRIC_DEFS, METRIC_IDS, MIN_SAMPLE, isMetricId, isMetricWindow, nearestRank, sliceAllowed, type MetricDef,
} from '../processMetrics'

test('ids are unique and every id has exactly one definition with one side', () => {
  expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length)
  expect(METRIC_DEFS.map(d => d.id)).toEqual([...METRIC_IDS])
  for (const d of METRIC_DEFS) expect(['author', 'reviewer', 'sender', 'turn', 'team']).toContain(d.side)
})

test('every efficiency metric has a guard, and every guard is a guard metric', () => {
  const byId = new Map(METRIC_DEFS.map(d => [d.id, d]))
  for (const d of METRIC_DEFS) {
    if (d.role === 'efficiency') expect({ id: d.id, guard: d.guard !== null }).toEqual({ id: d.id, guard: true })
    if (d.guard) expect(byId.get(d.guard)?.role).toBe('guard')
    if (d.role !== 'efficiency') expect(d.guard).toBeNull()
  }
  const guardOf = (id: string) => byId.get(id as MetricDef['id'])!.guard
  expect(guardOf('lead_time_p50')).toBe('accepted_result_share')
  expect([guardOf('mail_share'), guardOf('fix_iterations'), guardOf('finding_fail_rate')]).toEqual(['reopen_rate', 'reopen_rate', 'reopen_rate'])
  expect(guardOf('tokens_per_task')).toBe('first_pass_yield')
  expect(MIN_SAMPLE).toBe(10)
})

test('sides decide slicing', () => {
  const get = (id: string) => METRIC_DEFS.find(d => d.id === id)!
  expect(sliceAllowed(get('finding_fail_rate'), { kind: 'groupFileHash' })).toBe(true)
  expect(sliceAllowed(get('mail_share'), { kind: 'group' })).toBe(true)
  expect(sliceAllowed(get('mail_share'), { kind: 'profile' })).toBe(false)
  expect(sliceAllowed(get('lead_time_p50'), { kind: 'group' })).toBe(false)
  expect(sliceAllowed(get('limit_tax_hours'), { kind: 'profile' })).toBe(true)
  expect(sliceAllowed(get('limit_tax_hours'), { kind: 'group' })).toBe(false)
})

test('nearest-rank percentiles and guards on ids and windows', () => {
  expect(nearestRank([], 50)).toBeNull()
  expect(nearestRank([5, 1, 3, 2, 4], 50)).toBe(3)
  expect(nearestRank([5, 1, 3, 2, 4], 90)).toBe(5)
  expect(nearestRank([1, 2, 3, 4], 50)).toBe(2)
  expect(isMetricId('reopen_rate')).toBe(true)
  expect(isMetricId('velocity')).toBe(false)
  expect(isMetricWindow('7d')).toBe(true)
  expect(isMetricWindow('30d')).toBe(false)
})
