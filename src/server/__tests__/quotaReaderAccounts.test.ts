// Account identity through the production composition (process-quota-
// history-and-incident-advice B5, B6, S3/P1; Sol checkpoint note-c031d34a
// items 2 and 4): a real ChatSessionManager, an injected fetch and fake
// timers. A retired key's late answer is history only and never replaces
// the live report; a worker observation reaches only the teams whose live
// sessions use its account; a worker on another key never marks a session's
// provider as routed; and one held worker poll is joined by a spawn pull and
// by a session cadence tick (one fetch, every team's history).
import { afterEach, expect, test } from 'bun:test'
import {
  advance, CADENCE_MS, extraProject, historyRows, jsonResponse, QUOTA_TOKEN, QUOTA_TOKEN_B, quotaCapture,
  quotaComposition, sessionIn, settle, type QuotaComposition,
} from './helpers/quotaComposition'

let composition: QuotaComposition | undefined
const OTHER_ORIGIN = 'https://zai-b.test/api/anthropic'

afterEach(async () => {
  await composition?.close()
  composition = undefined
})

function held(): { answer: Promise<Response>; release: (percent: number) => void } {
  let resolve!: (response: Response) => void
  const answer = new Promise<Response>(done => { resolve = done })
  return { answer, release: percent => resolve(jsonResponse(quotaCapture(percent))) }
}

const percentOf = (row: Record<string, unknown>) => JSON.parse(String(row.windows_json))[0]?.percentUsed as number | undefined
const teamOf = (sessionId: string) => composition!.manager.teams.teamOf(sessionId)!.teamId

async function start(sessionId: string): Promise<void> {
  await composition!.manager.send(sessionId, 'hello')
  await settle()
}

test('a retired key\'s late answer after a credential change goes to history under its own scope and never replaces the live report', async () => {
  const env: Record<string, string> = { ZQ_TOKEN: QUOTA_TOKEN }
  composition = await quotaComposition({ env })
  composition.writeGroup('workers: [glm]')
  const old = held()
  composition.answers.push(old.answer, jsonResponse(quotaCapture(40)))
  await sessionIn(composition)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN])
  // Rotate the credential; the next team resolution reconciles the new key.
  env.ZQ_TOKEN = QUOTA_TOKEN_B
  await sessionIn(composition)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  // The old key answers a second later, inside its 10 s bound.
  await advance(1_000)
  old.release(12)
  await settle()
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  const rows = historyRows(composition.db)
  expect(rows.map(percentOf).sort()).toEqual([12, 40])
  expect(new Set(rows.map(row => row.account_scope)).size).toBe(2)
})

// One provider has one effective key at a time (credentials and base URLs
// are user-level, the values come from the server environment), so two keys
// of a provider coexist across a credential rotation.
test('after a rotation a session on the new key pulls its own account, not the retired worker key\'s, and the new key\'s observation reaches the worker and session teams', async () => {
  const env: Record<string, string> = { ZQ_TOKEN: QUOTA_TOKEN }
  composition = await quotaComposition({ env, sdkPull: true })
  composition.writeGroup('workers: [glm]')
  const anchorA = await sessionIn(composition)
  // C: a glm session in a team that lists no glm worker.
  const sessionC = await sessionIn(composition, extraProject(composition, 'project-c', 'workers: [hostonly]'), 'glm')
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN])
  // The K1 worker proved zai quota-serving; C starts after the credential moved to K2.
  env.ZQ_TOKEN = QUOTA_TOKEN_B
  composition.answers.push(jsonResponse(quotaCapture(70)))
  await start(sessionC)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(70)
  // The sweep moves the worker to K2: its poll is the live account's, for A and C.
  composition.answers.push(jsonResponse(quotaCapture(33)))
  await advance(61_000)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B, QUOTA_TOKEN_B])
  const k2 = historyRows(composition.db).filter(row => percentOf(row) === 33)
  expect(k2.map(row => String(row.team_id)).sort()).toEqual([teamOf(anchorA), teamOf(sessionC)].sort())
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(33)
  // The K1 observation reached team A only: C never ran on K1.
  const k1Scope = historyRows(composition.db)[0]!.account_scope
  const k1 = historyRows(composition.db).filter(row => row.account_scope === k1Scope)
  expect(k1.map(row => String(row.team_id))).toEqual([teamOf(anchorA)])
})

// @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Shared account polled once
test('a spawn pull and a worker subscription during held requests join them: one fetch each time, and both teams\' histories get it', async () => {
  composition = await quotaComposition({ sdkPull: true })
  composition.writeGroup('workers: [glm]')
  const first = held()
  composition.answers.push(first.answer)
  const anchorA = await sessionIn(composition)
  const sessionC = await sessionIn(composition, extraProject(composition, 'project-c', 'workers: [hostonly]'), 'glm')
  expect(composition.calls).toHaveLength(1)
  // C starts while the worker poll is held: its spawn pull joins it (P1).
  await start(sessionC)
  expect(composition.calls).toHaveLength(1)
  first.release(21)
  await settle()
  const teams = [teamOf(anchorA), teamOf(sessionC)].sort()
  expect(historyRows(composition.db).filter(row => percentOf(row) === 21).map(row => String(row.team_id)).sort()).toEqual(teams)
  // C's session cadence now serves the key: hold its next tick's request.
  const second = held()
  composition.answers.push(second.answer)
  const calls = composition.calls.length
  for (let at = 0; at < CADENCE_MS * 1.2 && composition.calls.length === calls; at += 1_000) await advance(1_000)
  expect(composition.calls).toHaveLength(calls + 1)
  // A drops and re-lists its glm worker during it: the new subscription's poll (B1) joins the held tick.
  composition.writeGroup('workers: [hostonly]')
  await sessionIn(composition)
  expect(composition.manager.quota.service.workerKeys()).toHaveLength(0)
  composition.writeGroup('workers: [glm]')
  await sessionIn(composition)
  expect(composition.manager.quota.service.workerKeys()).toHaveLength(1)
  expect(composition.calls).toHaveLength(calls + 1)
  second.release(22)
  await settle()
  expect(composition.calls).toHaveLength(calls + 1)
  expect(historyRows(composition.db).filter(row => percentOf(row) === 22).map(row => String(row.team_id)).sort()).toEqual(teams)
})
