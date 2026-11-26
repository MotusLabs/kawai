// Table E row E5 through the production composition (process-quota-history-
// and-incident-advice D4, contract r2 A4/V1): a real ChatSessionManager whose
// reader polled the configured `glm` worker fresh (independent capacity), and
// a managed-task session — working in a subdirectory of its git worktree —
// that hits a final limit. The writer facts come from the manager's own
// staffing adapter (`writerSlot`), never a fixture: a pending spawn
// reservation of the worktree excludes `glm`, and the limited writer's own
// hold lists it behind the release-or-hand-off prerequisite. Dropping the
// adapter's pending count, its occupants, or its worktree-root resolution
// fails this file.
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerMessage } from '../../shared/types'
import type { ChatConnection } from '../chat/ChatConnections'
import { cleanGitEnv } from '../git/gitCommand'
import { ADVICE_COALESCE_MS } from '../metrics/recommendations/service'
import { MetricsConnections } from '../metrics/metricsConnections'
import { recommendationHandlers, type RecommendationToolDeps } from '../metrics/recommendations/tools'
import { advance, historyRows, jsonResponse, quotaCapture, quotaComposition, settle, type QuotaComposition } from './helpers/quotaComposition'

let composition: QuotaComposition | undefined

afterEach(async () => {
  await composition?.close()
  composition = undefined
})

/**
 * The composition's project as a git worktree, glm polled fresh, and the
 * limited managed-task session (profile `default`) in its `src/` directory.
 */
async function managedIncident(spawned: boolean, before?: (team: string) => void) {
  composition = await quotaComposition()
  const git = spawnSync('git', ['init', '-q', composition.project], { env: cleanGitEnv() })
  if (git.status !== 0) throw new Error('git init failed')
  fs.mkdirSync(path.join(composition.project, 'src'))
  composition.writeGroup('max: 3\nworkers: [default, glm]')
  composition.setFallback(() => jsonResponse(quotaCapture(20)))
  const { manager } = composition
  const created = await manager.createAvailableSession({
    projectPath: path.join(composition.project, 'src'), groupId: 'devs', taskId: 'task-managed', spawned,
  })
  if (!created.ok) throw new Error(created.error)
  const sessionId = created.session.id
  await manager.teams.resolvedTeamOf(sessionId)
  await settle()
  const team = manager.teams.teamOf(sessionId)!.teamId
  const row = historyRows(composition.db).find(entry => entry.provider_id === 'zai')
  expect(row).toMatchObject({ team_id: team, outcome: 'supported', account_basis: 'routed' })
  before?.(team)
  manager.limitEvents.record({
    profileId: 'default', sessionId, groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'rate limited',
    resetsAt: new Date(Date.now() + 3600_000).toISOString(), providerId: null, window: 'five_hour',
  })
  await advance(ADVICE_COALESCE_MS + 1_000)
  const services = (manager as unknown as { teamServices: () => { recommendations: RecommendationToolDeps } }).teamServices()
  const tools = recommendationHandlers(services.recommendations, sessionId)
  const { recommendations } = await tools.process_recommendations_list({})
  expect(recommendations).toHaveLength(1)
  const detail = await tools.process_recommendation_get({ id: recommendations[0]!.id })
  expect(detail.taskId).toBe('task-managed')
  expect(detail.assessments).toHaveLength(1)
  // The human's Metrics snapshot carries the same assessment.
  const sent: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => sent.push(message) } as unknown as ChatConnection
  await new MetricsConnections(manager).handle(connection, { type: 'process-metrics-open', teamPath: composition.project, window: '7d', slice: null })
  const snapshot = sent.find((message): message is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> => message.type === 'process-metrics-snapshot')
  expect(JSON.parse(JSON.stringify(snapshot!.recommendations))).toEqual([JSON.parse(JSON.stringify(detail))])
  const advice = detail.assessments[0]!.advice
  return { advice, glm: advice.alternatives.find(entry => entry.profileId === 'glm') }
}

// @covers: process-recommendations › Switch comparisons respect all eligibility and quota constraints › Empty writer slot required
test('E5 in production: a pending spawn reservation of the managed task\'s worktree excludes a fresh alternative', async () => {
  const { advice, glm } = await managedIncident(false, team => {
    composition!.db.db.prepare(`INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id)
      VALUES (?, ?, ?, 'devs', ?, ?, 'glm')`).run(randomUUID(), `msg-${randomUUID()}`, team, composition!.project, new Date().toISOString())
  })
  // Fresh capacity was observed, but the reservation claims the writer slot.
  expect(glm).toMatchObject({ providerId: 'zai', listed: false, headroomReason: 'fresh', exclusion: { kind: 'writer-slot' } })
  expect(glm!.exclusion!.detail).toBe('the writer slot is reserved by 1 pending spawn: release or hand off first')
  expect(advice.choice).not.toBe('switch')
})

// @covers: process-recommendations › Switch comparisons respect all eligibility and quota constraints › Empty writer slot required
test('E5 in production: the limited writer\'s own hold lists a fresh alternative behind release or hand-off', async () => {
  const { advice, glm } = await managedIncident(true)
  expect(glm).toMatchObject({ providerId: 'zai', listed: true, exclusion: null, headroom: 'known' })
  expect(advice.choice).toBe('switch')
  expect(advice.facts).toContain('The limited session holds the writer slot: it must release or hand off before another worker can execute.')
  expect(advice.summary).toContain('once the limited session releases or hands off the writer slot')
})
