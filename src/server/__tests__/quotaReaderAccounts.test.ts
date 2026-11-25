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

/** Settle until `ready` holds (a loaded shared process may need more turns); throws if it never does. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 40 && !ready(); turn++) await settle()
  if (!ready()) throw new Error('condition never held')
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
  await until(() => composition!.calls.length === 2)
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

// Sol re-check note-d5b9f0e9 item 2: a held request spans two instants, so a
// joined session's recipients are captured under the request's key, and no
// live path publishes a retired key's answer.
test('a spawn joined to a held old-key poll before a rotation publishes nothing live, and a team that only used the new key gets none of the old key\'s history', async () => {
  const env: Record<string, string> = { ZQ_TOKEN: QUOTA_TOKEN }
  composition = await quotaComposition({ env, sdkPull: true })
  composition.writeGroup('workers: [glm]')
  const old = held()
  composition.answers.push(old.answer, jsonResponse(quotaCapture(40)))
  const anchorA = await sessionIn(composition)
  const sessionB = await sessionIn(composition, extraProject(composition, 'project-b', 'workers: [hostonly]'), 'glm')
  // B's spawn pull joins the held K1 worker poll.
  await start(sessionB)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN])
  // Rotate; C's team resolution moves the worker to K2, which answers 40%.
  env.ZQ_TOKEN = QUOTA_TOKEN_B
  const sessionC = await sessionIn(composition, extraProject(composition, 'project-c', 'workers: [hostonly]'), 'glm')
  await start(sessionC)
  await until(() => composition!.calls.length === 2)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  // K1 answers a second later, inside its bound.
  await advance(1_000)
  old.release(12)
  await settle()
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  const k1 = historyRows(composition.db).filter(row => percentOf(row) === 12)
  expect(k1.map(row => String(row.team_id)).sort()).toEqual([teamOf(anchorA), teamOf(sessionB)].sort())
})

// Sol re-check note-d5b9f0e9 item 1: the accepted capture echoes the
// credential in an unknown window kind; the client-facing usage trace (the
// manager's onUsage, published to chat connections) carries none of it.
test('an accepted answer echoing the credential reaches the live usage trace redacted, through a worker poll and a spawn pull', async () => {
  composition = await quotaComposition({ sdkPull: true })
  composition.writeGroup('workers: [glm]')
  await sessionIn(composition)
  const session = await sessionIn(composition, extraProject(composition, 'project-c', 'workers: [hostonly]'), 'glm')
  await start(session)
  await advance(CADENCE_MS * 1.2)
  expect(composition.calls.length).toBeGreaterThanOrEqual(2)
  const trace = JSON.stringify([composition.usage, composition.manager.providerUsageOf('zai')])
  expect(trace).not.toContain(QUOTA_TOKEN)
  expect(trace).toContain('zai:unknown#1')
  expect(historyRows(composition.db).length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(historyRows(composition.db))).not.toContain(QUOTA_TOKEN)
})

test('a session cadence tick held across a rotation publishes nothing live when it answers after the new key\'s poll', async () => {
  const env: Record<string, string> = { ZQ_TOKEN: QUOTA_TOKEN }
  composition = await quotaComposition({ env, sdkPull: true })
  composition.writeGroup('workers: [hostonly]')
  const session = await sessionIn(composition, composition.project, 'glm')
  await start(session)
  await until(() => composition!.calls.length === 1)
  // Hold the next cadence tick's K1 request.
  const tick = held()
  composition.answers.push(tick.answer, jsonResponse(quotaCapture(40)))
  for (let at = 0; at < CADENCE_MS * 1.2 && composition.calls.length === 1; at += 1_000) await advance(1_000)
  expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN])
  // Rotate; a glm worker listed now polls K2, which answers 40%.
  env.ZQ_TOKEN = QUOTA_TOKEN_B
  composition.writeGroup('workers: [glm]')
  await sessionIn(composition)
  await until(() => composition!.calls.length === 3)
  expect(composition.calls[2]!.auth).toBe(QUOTA_TOKEN_B)
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  await advance(1_000)
  tick.release(12)
  await settle()
  expect(composition.manager.providerUsageOf('zai')?.windows[0]?.percentUsed).toBe(40)
  expect(historyRows(composition.db).some(row => percentOf(row) === 12)).toBe(true)
})
