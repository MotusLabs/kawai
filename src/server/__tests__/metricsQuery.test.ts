// The metrics core's load (team-process-metrics D4): cohorts by in-range
// events, then their whole history by id — a task created long before the
// range and first done inside it keeps its full lead time, a task first done
// earlier never re-enters, pre-range results and turns of a cohort task load,
// a limit event before the range still cools into it, and another team's
// rows never load.
import { expect, test } from 'bun:test'
import { computeMetrics } from '../metrics/computeMetrics'
import { loadMetricsInputs } from '../metrics/metricsQuery'
import { DAY, END, Seed, TEAM, ago } from './metricsSeed'

const FROM = END - 14 * DAY

test('cohorts load by first done in range with their whole history; earlier-done tasks stay out', () => {
  const s = new Seed()
  s.task('old-created', 20 * 24)
  s.status('old-created', 'open', 'active', 19 * 24)
  const preResult = s.result('old-created', 'chat-dev', 18 * 24)
  s.usage('chat-dev', 18 * 24, 500, { taskId: 'old-created' })
  s.status('old-created', 'active', 'done', 2 * 24)

  s.task('redone', 30 * 24)
  s.status('redone', 'active', 'done', 20 * 24)
  s.status('redone', 'done', 'active', 3 * 24)
  s.status('redone', 'active', 'done', 2 * 24)

  s.task('other-team', 5 * 24, 'open', '/other/.git')
  s.status('other-team', 'active', 'done', 24, '/other/.git')

  const inputs = loadMetricsInputs(s.db, TEAM, FROM, END)
  expect([...inputs.tasks.keys()].sort()).toEqual(['old-created', 'redone'])
  expect(inputs.tasks.get('old-created')!.createdAt).toBe(ago(20 * 24))
  expect(inputs.statusEvents.filter(e => e.taskId === 'old-created').map(e => e.toStatus)).toEqual(['active', 'done'])
  expect(inputs.results.map(r => r.id)).toEqual([preResult])
  expect(inputs.usage.map(u => u.usage.inputTokens)).toEqual([500])
  // Recording began with the first turn, 18 days ago.
  expect(inputs.usageHorizon).toBe(END - 18 * DAY)
  // `redone` loads for its in-range transitions, but its first done predates the range.
  expect(inputs.statusEvents.filter(e => e.taskId === 'redone').map(e => e.at)).toEqual([ago(20 * 24), ago(3 * 24), ago(2 * 24)])
  s.db.close()
})

test('findings, task mail of first-done tasks, starts, manifests, and session profiles load', () => {
  const s = new Seed()
  s.task('t', 3 * 24)
  const r = s.result('t', 'chat-dev', 30)
  s.finding('t', r, 'chat-rev', 'fail', 20)
  s.status('t', 'active', 'done', 10)
  const old = s.message({ createdHoursAgo: 30 * 24, deliveredHoursAgo: 30 * 24, taskId: 't', claimedBy: 'chat-dev' })
  s.message({ createdHoursAgo: 30 * 24, taskId: null })
  s.start('chat-dev', 40, { id: 'start-dev', memoryHash: 'mem-1' })
  s.start('chat-rev', 25, { id: 'start-rev' })
  s.start('chat-stranger', 25, { id: 'start-stranger' })
  s.manifest('mem-1', { 'MEMORY.md': 'h1' })
  s.db.prepare(`INSERT INTO chat_sessions (session_id, name, project_path, profile_id, status, created_at, last_activity_at,
    approval_policy, name_source, spawned) VALUES ('chat-dev', 'dev', '/repo', 'glm', 'waiting', ?, ?, 'manual', 'user', 0)`).run(ago(40), ago(1))

  const inputs = loadMetricsInputs(s.db, TEAM, FROM, END)
  expect(inputs.findings.map(f => f.verdict)).toEqual(['fail'])
  expect([...inputs.messages.keys()]).toEqual([old])
  expect(inputs.starts.map(st => st.id)).toEqual(['start-dev', 'start-rev'])
  expect(inputs.manifests.get('mem-1')).toEqual({ 'MEMORY.md': 'h1' })
  expect(inputs.sessionProfiles.get('chat-dev')).toBe('glm')
  s.db.close()
})

test('the usage horizon is retention when turns reach back that far, the end when none were recorded', () => {
  const s = new Seed()
  expect(loadMetricsInputs(s.db, TEAM, FROM, END).usageHorizon).toBe(END)
  s.usage('chat-dev', 100 * 24, 1)
  expect(loadMetricsInputs(s.db, TEAM, FROM, END).usageHorizon).toBe(END - 90 * DAY)
  s.db.close()
})

test('mail sent or delivered in range and park episodes opened before it load', () => {
  const s = new Seed()
  const inRange = s.message({ createdHoursAgo: 15 * 24, deliveredHoursAgo: 13 * 24 })
  s.message({ createdHoursAgo: 15 * 24, deliveredHoursAgo: 15 * 24 })
  const parked = s.message({ createdHoursAgo: 16 * 24, state: 'parked', claimedBy: 'chat-dev' })
  s.event(parked, 'parked', 15 * 24)
  s.event(parked, 'unparked', 13 * 24)
  s.message({ createdHoursAgo: 2, team: '/other/.git' })
  // Old mail dead-lettered in range loads too, so its friction drill-down can open the thread.
  const old = s.message({ createdHoursAgo: 30 * 24 })
  s.event(old, 'dead-lettered', 2)

  const inputs = loadMetricsInputs(s.db, TEAM, FROM, END)
  expect([...inputs.messages.keys()].sort()).toEqual([inRange, parked, old].sort())
  expect(inputs.messages.get(old)!.threadId).toBe(old)
  expect(inputs.messageEvents.map(e => e.kind)).toEqual(['parked', 'unparked', 'dead-lettered'])
  s.db.close()
})

test('limit events of profiles the team hit load from 24 h before the range', () => {
  const s = new Seed()
  s.member('chat-dev')
  s.limit('glm', 'chat-dev', 14 * 24 + 5, 14 * 24 - 2)
  s.limit('glm', 'chat-elsewhere', 14 * 24 + 30, null)
  s.limit('opus', 'chat-other-team', 2, 1)

  const inputs = loadMetricsInputs(s.db, TEAM, FROM, END)
  expect([...inputs.limitEvents.keys()]).toEqual(['glm'])
  expect(inputs.limitEvents.get('glm')!.map(e => e.sessionId)).toEqual(['chat-dev'])
  s.db.close()
})

test('a released park keeps its holder: starts load for event holders, so parked hours carry the holder profile', () => {
  const s = new Seed()
  // The holder did nothing else in range, and release cleared the message's claim.
  const released = s.message({ createdHoursAgo: 10 * 24, state: 'queued', claimedBy: null })
  s.event(released, 'parked', 8 * 24, { prevClaimedBy: 'chat-holder' })
  s.event(released, 'released', 24, { prevClaimedBy: 'chat-holder' })
  s.start('chat-holder', 20 * 24, { id: 'start-holder', profile: 'profile-a' })

  const inputs = loadMetricsInputs(s.db, TEAM, FROM, END)
  expect(inputs.starts.map(st => st.id)).toEqual(['start-holder'])
  const tax = computeMetrics(inputs, '7d', null, END).metrics.find(metric => metric.id === 'limit_tax_hours')!
  expect(tax.breakdown?.map(row => row.key)).toEqual(['profile-a'])
  s.db.close()
})
