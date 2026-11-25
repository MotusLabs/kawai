// Quota history to advice through the production composition (process-quota-
// history-and-incident-advice D1/D3/D4, contract r2 V1): a real
// ChatSessionManager whose reader polls the configured `glm` worker (no agent
// runs on it) through an injected fetch. A final limit of a session on another
// provider then freezes `glm` as an alternative whose account scope — resolved
// by the manager for the incident — matches the scope the reader stored with
// that observation, so its headroom is known and the advice is a provisional
// switch. The team tools (built from the manager's own services) and the
// Metrics snapshot read that same assessment. Disconnecting the manager's
// account-scope resolution leaves the headroom unknown and fails this test.
import { afterEach, expect, test } from 'bun:test'
import type { ServerMessage } from '../../shared/types'
import type { ChatConnection } from '../chat/ChatConnections'
import { ADVICE_COALESCE_MS } from '../metrics/recommendations/service'
import { MetricsConnections } from '../metrics/metricsConnections'
import { recommendationHandlers, type RecommendationToolDeps } from '../metrics/recommendations/tools'
import { advance, anchorSession, historyRows, jsonResponse, quotaCapture, quotaComposition, type QuotaComposition } from './helpers/quotaComposition'

let composition: QuotaComposition | undefined

afterEach(async () => {
  await composition?.close()
  composition = undefined
})

test('a configured worker\'s polled headroom reaches the advice that the team tools and Metrics read, under the incident\'s account scope', async () => {
  composition = await quotaComposition()
  composition.writeGroup('max: 2\nworkers: [default, glm]')
  composition.setFallback(() => jsonResponse(quotaCapture(20)))
  const sessionId = await anchorSession(composition)
  const { manager } = composition
  const team = manager.teams.teamOf(sessionId)!.teamId
  // The reader polled glm with no agent: a routed, scoped observation for the
  // team (the host-login `default` worker records `unsupported` once, S9).
  const rows = historyRows(composition.db)
  expect(rows.map(entry => [entry.provider_id, entry.outcome]).sort()).toEqual([['default', 'unsupported'], ['zai', 'supported']])
  const row = rows.find(entry => entry.provider_id === 'zai')
  expect(row).toMatchObject({ team_id: team, provider_id: 'zai', account_basis: 'routed', reason: 'worker', outcome: 'supported' })
  expect(row!.account_scope).toEqual(expect.any(String))
  expect(composition.handles).toHaveLength(0)

  // The anchor session (profile `default`) hits a final limit.
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
  const [assessment] = detail.assessments
  expect(detail.assessments).toHaveLength(1)
  const glm = assessment!.advice.alternatives.find(entry => entry.profileId === 'glm')
  expect(glm).toMatchObject({ providerId: 'zai', listed: true, exclusion: null, headroom: 'known', headroomReason: 'fresh', observationId: row!.id })
  expect(assessment!.advice.choice).toBe('switch')
  expect(assessment!.evidence.map(entry => entry.observationId)).toContain(row!.id as string)

  // The human's Metrics snapshot carries the same assessment.
  const sent: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => sent.push(message) } as unknown as ChatConnection
  await new MetricsConnections(manager).handle(connection, { type: 'process-metrics-open', teamPath: composition.project, window: '7d', slice: null })
  const snapshot = sent.find((message): message is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> => message.type === 'process-metrics-snapshot')
  expect(JSON.parse(JSON.stringify(snapshot!.recommendations))).toEqual([JSON.parse(JSON.stringify(detail))])
  // Collection started no agent (I1).
  expect(composition.handles).toHaveLength(0)
})
