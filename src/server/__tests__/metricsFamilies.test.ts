// The metric families (team-process-metrics D4) over a seeded database:
// flow (lead time to the first `done`, approximate for backfilled rows; mail
// wait from the later of creation and the scheduled time), quality and
// coverage (disagreeing reviewers, fail-then-pass, tasks with no result),
// overhead (mail share, task mail per task, friction with its messages), and
// capacity (the router's cooling timeline, open parks, task-less tokens,
// partial tokens past usage retention).
import { expect, test } from 'bun:test'
import { METRIC_DEF_BY_ID, type MetricId } from '../../shared/processMetrics'
import { capacityObservations } from '../metrics/capacity'
import { flowObservations } from '../metrics/flow'
import { metricsContext } from '../metrics/metricsContext'
import { loadMetricsInputs } from '../metrics/metricsQuery'
import { overheadObservations } from '../metrics/overhead'
import { coverageObservations, qualityObservations } from '../metrics/quality'
import { aggregate, rows, type Observation } from '../metrics/slices'
import { DAY, END, Seed, TEAM } from './metricsSeed'

const week = (s: Seed) => metricsContext(loadMetricsInputs(s.db, TEAM, END - 14 * DAY, END), END - 7 * DAY, END)
const value = (obs: Observation[], id: MetricId) => aggregate(METRIC_DEF_BY_ID.get(id)!, obs.filter(o => o.metric === id))
const breakdown = (obs: Observation[], id: MetricId) => {
  const mine = obs.filter(o => o.metric === id)
  return Object.fromEntries(rows(METRIC_DEF_BY_ID.get(id)!, mine, [], o => o.key).map(r => [r.key, r.value]))
}

test('lead time ends at the first done, keeps a long history, and marks backfilled rows approximate', () => {
  const s = new Seed()
  s.task('long', 20 * 24)
  s.status('long', 'active', 'done', 2 * 24)
  s.status('long', 'done', 'active', 30)
  s.status('long', 'active', 'done', 10)
  s.task('backfilled', 3 * 24, 'done')
  s.status('backfilled', null, 'done', 24)
  const obs = flowObservations(week(s))
  const lead = value(obs, 'lead_time_p90')
  expect(lead.n).toBe(2)
  expect(lead.value).toBe(18 * 24)
  expect(lead.approximate).toBe(true)
  expect(value(obs.filter(o => o.task === 'long'), 'lead_time_p50').approximate).toBe(false)
  s.db.close()
})

test('empty windows read null; scheduled mail waits from its scheduled time, urgent apart', () => {
  const empty = new Seed()
  expect(value(flowObservations(week(empty)), 'lead_time_p50')).toMatchObject({ value: null, n: 0, insufficient: true })
  empty.db.close()

  const s = new Seed()
  s.message({ createdHoursAgo: 10, deliverHoursAgo: 5, deliveredHoursAgo: 5 - 2 / 60 })
  s.message({ createdHoursAgo: 3, deliveredHoursAgo: 2.5, priority: 'urgent' })
  const obs = flowObservations(week(s))
  expect(value(obs, 'mail_wait_normal_p50').value).toBeCloseTo(2, 6)
  expect(value(obs, 'mail_wait_urgent_p50').value).toBeCloseTo(30, 6)
  s.db.close()
})

test('quality: disagreeing reviewers fail first pass, each finding counts once, fail-then-pass iterates once', () => {
  const s = new Seed()
  s.task('split', 5 * 24)
  const r1 = s.result('split', 'chat-dev', 4 * 24)
  s.finding('split', r1, 'chat-rev-a', 'pass', 3 * 24)
  s.finding('split', r1, 'chat-rev-b', 'fail', 3 * 24 - 1)
  const r2 = s.result('split', 'chat-dev', 2 * 24)
  s.finding('split', r2, 'chat-rev-a', 'pass', 2 * 24 - 1)
  s.status('split', 'active', 'done', 24)
  s.task('clean', 5 * 24)
  const r3 = s.result('clean', 'chat-dev', 4 * 24, { acceptedHoursAgo: 30 })
  s.finding('clean', r3, 'chat-rev-a', 'pass', 3 * 24)
  s.status('clean', 'active', 'done', 24)
  s.task('bare', 5 * 24)
  s.status('bare', 'active', 'done', 24)
  s.status('bare', 'done', 'open', 20)
  s.status('bare', 'open', 'done', 12)

  const ctx = week(s)
  const obs = [...qualityObservations(ctx), ...coverageObservations(ctx)]
  expect(value(obs, 'first_pass_yield')).toMatchObject({ value: 0.5, n: 2 })
  expect(value(obs, 'finding_fail_rate')).toMatchObject({ value: 0.25, n: 4 })
  expect(value(obs, 'fix_iterations')).toMatchObject({ value: 0.5, n: 2 })
  expect(value(obs, 'reopen_rate')).toMatchObject({ value: 0.25, n: 4 })
  expect(value(obs, 'coverage_result').value).toBeCloseTo(2 / 3)
  expect(value(obs, 'coverage_findings').value).toBeCloseTo(2 / 3)
  expect(value(obs, 'accepted_result_share').value).toBeCloseTo(1 / 3)
  s.db.close()
})

test('overhead: mail share by sender group, task mail per done task, friction by kind with its messages', () => {
  const s = new Seed()
  s.task('t', 5 * 24)
  s.status('t', 'active', 'done', 24)
  for (let i = 0; i < 4; i++) s.message({ createdHoursAgo: 30 + i, fromGroup: 'lead', taskId: i < 2 ? 't' : null })
  s.message({ createdHoursAgo: 30, fromGroup: 'devs', taskId: 't' })
  s.message({ createdHoursAgo: 30, fromKind: 'human', fromGroup: null })
  s.message({ createdHoursAgo: 20 * 24, fromGroup: 'devs', taskId: 't' })
  const parked = s.message({ createdHoursAgo: 40 })
  s.event(parked, 'parked', 39)
  const dead = s.message({ createdHoursAgo: 40 })
  s.event(dead, 'dead-lettered', 38)

  const obs = overheadObservations(week(s))
  expect(value(obs, 'mail_share')).toMatchObject({ value: null, n: 8 })
  expect(breakdown(obs, 'mail_share')).toEqual({ devs: 1 / 8, human: 1 / 8, lead: 6 / 8 })
  expect(value(obs, 'task_mail_per_task')).toMatchObject({ value: 4, n: 1 })
  expect(breakdown(obs, 'task_mail_per_task')).toEqual({ devs: 2, lead: 2 })
  expect(value(obs, 'friction_total')).toMatchObject({ value: 2, messages: [parked, dead] })
  expect(breakdown(obs, 'friction_per_task')).toEqual({ 'dead-lettered': 1, parked: 1 })
  s.db.close()
})

test('capacity: a provider event spreads the tax to its silent sibling; a model-scoped window does not', () => {
  const s = new Seed()
  s.member('chat-glm')
  // glm's provider-scoped limit stands for three hours; glm-flash records nothing.
  s.limit('glm', 'chat-glm', 30, 27, true, { provider: 'zai' })
  const inputs = {
    ...loadMetricsInputs(s.db, TEAM, END - 14 * DAY, END),
    providerIds: new Map([['glm', 'zai'], ['glm-flash', 'zai'], ['opus', 'claude'], ['sonnet', 'claude']]),
  }
  const obs = capacityObservations(metricsContext(inputs, END - 7 * DAY, END))
  expect(breakdown(obs, 'limit_tax_hours').glm).toBeCloseTo(3, 6)
  expect(breakdown(obs, 'limit_tax_hours')['glm-flash']).toBeCloseTo(3, 6)
  s.db.close()

  const m = new Seed()
  m.member('chat-opus')
  // The seven_day_opus window is model-scoped: it stays opus's tax alone.
  m.limit('opus', 'chat-opus', 30, 27, true, { provider: 'claude', window: 'seven_day_opus' })
  const scoped = {
    ...loadMetricsInputs(m.db, TEAM, END - 14 * DAY, END),
    providerIds: new Map([['opus', 'claude'], ['sonnet', 'claude']]),
  }
  const scopedObs = capacityObservations(metricsContext(scoped, END - 7 * DAY, END))
  expect(breakdown(scopedObs, 'limit_tax_hours').opus).toBeCloseTo(3, 6)
  expect(breakdown(scopedObs, 'limit_tax_hours').sonnet).toBeUndefined()
  m.db.close()
})

test('capacity: the tax follows the router — a weekly window outlives a later sibling window', () => {
  const s = new Seed()
  s.member('chat-opus')
  // opus's model-scoped weekly event resets in 72 h; 1 h later a
  // provider-scoped five_hour event (sonnet's) resets 2 h after it. Routing
  // cools opus until the weekly event leaves the 24 h read window; the tax
  // is that span, not the sibling's three hours.
  s.limit('opus', 'chat-opus', 30, 30 - 72, true, { provider: 'claude', window: 'seven_day_opus' })
  s.limit('sonnet', 'chat-sonnet', 29, 27, true, { provider: 'claude', window: 'five_hour' })
  const inputs = {
    ...loadMetricsInputs(s.db, TEAM, END - 14 * DAY, END),
    providerIds: new Map([['opus', 'claude'], ['sonnet', 'claude']]),
  }
  const obs = capacityObservations(metricsContext(inputs, END - 7 * DAY, END))
  expect(breakdown(obs, 'limit_tax_hours').opus).toBeCloseTo(24, 6)
  s.db.close()
})

test('capacity: a superseding shorter reset, an open park, task-less tokens, and partial tokens', () => {
  const s = new Seed()
  s.member('chat-dev')
  s.limit('glm', 'chat-dev', 30, 25)
  s.limit('glm', 'chat-dev', 30 - 1 / 60, 30 - 2 / 60)
  const parked = s.message({ createdHoursAgo: 10, claimedBy: 'chat-dev', state: 'parked' })
  s.start('chat-dev', 50, { id: 'start-dev', profile: 'glm', group: 'devs' })
  s.event(parked, 'parked', 3, { prevClaimedBy: 'chat-dev' })
  s.start('chat-lead', 50, { id: 'start-lead', profile: 'opus', group: 'lead' })
  s.usage('chat-lead', 5, 1000, { startId: 'start-lead', group: 'lead', profile: 'opus' })
  s.task('old', 70 * 24)
  s.status('old', 'active', 'done', 24)
  s.usage('chat-dev', 9 * 24, 300, { taskId: 'old', startId: 'start-dev', group: 'devs', profile: 'glm' })
  s.usage('chat-dev', 2 * 24, 200, { taskId: 'old', startId: 'start-dev', group: 'devs', profile: 'glm' })

  const obs = capacityObservations(week(s))
  expect(breakdown(obs, 'limit_tax_hours').glm).toBeCloseTo(2 / 60 + 3, 6)
  expect(breakdown(obs, 'tokens_total')).toEqual({ 'devs · glm': 200, 'lead · opus': 1000 })
  const perTask = value(obs, 'tokens_per_task')
  expect(perTask).toMatchObject({ value: 500, n: 1, partial: true })
  expect(perTask.tasks).toEqual(['old'])
  s.db.close()
})
