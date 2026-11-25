// The quota reader through the production composition (process-quota-
// history-and-incident-advice task 3.2, design "Production composition
// checkpoint"): the manager-built QuotaReaderService with one configured team
// worker on a quota-serving provider and no session, an injected fetch and
// fake timers. Rows S1, S2, S7, S9, S11 and S14 of Table S and the main
// background scenarios run here; the remaining rows run at the service seam
// (quotaReaderTableS.test.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  advance, anchorSession, CADENCE_MS, historyRows, jsonResponse, QUOTA_TOKEN, QUOTA_TOKEN_B, quotaCapture,
  quotaComposition, settle, type QuotaComposition,
} from './helpers/quotaComposition'

let composition: QuotaComposition | undefined

afterEach(async () => {
  await composition?.close()
  composition = undefined
})

const QUOTA_URL = 'https://zai.test/api/monitor/usage/quota/limit'

describe('quota reader production composition', () => {
  // @covers: chat-usage-limits › Usage is refreshed when no report has arrived › Eligible alternative without a live chat
  test('S1/S2: a configured worker with no live session is polled now and on the cadence, filling quota history without an agent', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [glm]')
    composition.answers.push(jsonResponse(quotaCapture(12)), jsonResponse(quotaCapture(40)))
    await anchorSession(composition)
    // S1: one request at subscribe, with the worker's effective credential.
    expect(composition.calls).toEqual([{ url: QUOTA_URL, auth: QUOTA_TOKEN }])
    const first = historyRows(composition.db)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      provider_id: 'zai', account_alias: 'zai@zai.test', account_basis: 'routed', reason: 'worker', outcome: 'supported',
    })
    expect(JSON.parse(String(first[0]!.windows_json))[0]).toMatchObject({ percentUsed: 12 })
    // The provider's live report is filled for routing and team_capacity.
    expect(composition.manager.providerUsageOf('zai')?.windows[0]).toMatchObject({ percentUsed: 12 })
    // S2: one more request within the cadence ± 10 %, none before 90 % of it.
    await advance(CADENCE_MS * 0.89)
    expect(composition.calls).toHaveLength(1)
    await advance(CADENCE_MS * 0.22)
    expect(composition.calls).toHaveLength(2)
    expect(historyRows(composition.db).map(row => JSON.parse(String(row.windows_json))[0].percentUsed)).toEqual([12, 40])
    // I1: no agent was started for collection.
    expect(composition.handles).toHaveLength(0)
  })

  // @covers: chat-usage-limits › Provider usage stays fresh while sessions are live › Unused alternative stays observable
  test('a worker that remains configured keeps being observed across many cadences with no agent running', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [glm]')
    await anchorSession(composition)
    await advance(CADENCE_MS * 3.3)
    expect(composition.calls.length).toBeGreaterThanOrEqual(4)
    expect(historyRows(composition.db).every(row => row.reason === 'worker' && row.outcome === 'supported')).toBe(true)
    expect(composition.handles).toHaveLength(0)
  })

  // @covers: chat-usage-limits › Provider plan usage is pulled from the provider quota endpoint › Background provider configuration
  test('the background pull resolves the worker configuration and records its identity, never the credential', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [glm]')
    await anchorSession(composition)
    expect(composition.calls).toEqual([{ url: QUOTA_URL, auth: QUOTA_TOKEN }])
    const rows = historyRows(composition.db)
    expect(rows[0]).toMatchObject({ provider_id: 'zai', account_alias: 'zai@zai.test' })
    expect(JSON.stringify(rows)).not.toContain(QUOTA_TOKEN)
  })

  // @covers: chat-usage-limits › Provider usage stays fresh while sessions are live › No standalone reader
  test('S9: a worker whose usage only a running agent reports records unsupported once and launches nothing', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [hostonly]')
    await anchorSession(composition)
    await advance(CADENCE_MS * 2)
    expect(composition.calls).toEqual([])
    expect(composition.handles).toHaveLength(0)
    const rows = historyRows(composition.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'unsupported', reason: 'worker', windows_json: '[]' })
    expect(composition.manager.providerUsageOf(String(rows[0]!.provider_id))).toBeNull()
  })

  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Removing the last reason stops polling
  test('S7: dropping the provider from the last group file removes the timer and stops requests', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [glm]')
    await anchorSession(composition)
    expect(composition.calls).toHaveLength(1)
    composition.writeGroup('workers: [hostonly]')
    // The next sweep reconciles the edited file.
    await advance(61_000)
    expect(composition.manager.quota.service.workerKeys()).toEqual([])
    await advance(CADENCE_MS * 2)
    expect(composition.calls).toHaveLength(1)
  })

  test('S14: a credential change unsubscribes the old key and polls the new one once', async () => {
    const env: Record<string, string> = { ZQ_TOKEN: QUOTA_TOKEN }
    composition = await quotaComposition({ env })
    composition.writeGroup('workers: [glm]')
    await anchorSession(composition)
    expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN])
    env.ZQ_TOKEN = QUOTA_TOKEN_B
    await advance(61_000)
    expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
    expect(composition.manager.quota.service.workerKeys()).toHaveLength(1)
    await advance(CADENCE_MS * 1.11)
    expect(composition.calls.map(call => call.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B, QUOTA_TOKEN_B])
  })

  // @covers: chat-usage-limits › Provider usage stays fresh while sessions are live › Shutdown stops refreshes
  test('S11: shutdown with a worker request in flight publishes and records nothing and requests nothing more', async () => {
    composition = await quotaComposition()
    composition.writeGroup('workers: [glm]')
    await anchorSession(composition)
    let release!: (response: Response) => void
    composition.answers.push(new Promise<Response>(resolve => { release = resolve }))
    // Step to the cadence tick, so the hung request is still in flight (its 10 s timeout has not fired).
    for (let step = 0; step < 700 && composition.calls.length < 2; step++) await advance(1_000)
    expect(composition.calls).toHaveLength(2)
    expect(composition.manager.quota.service.inFlightFor({ providerId: 'zai', baseUrl: 'https://zai.test/api/anthropic', token: QUOTA_TOKEN })).toBe(true)
    const rowsBefore = historyRows(composition.db).length
    const usageBefore = composition.usage.length
    composition.manager.shutdown()
    release(jsonResponse(quotaCapture(77)))
    await settle()
    await advance(CADENCE_MS * 2)
    expect(composition.calls).toHaveLength(2)
    expect(historyRows(composition.db)).toHaveLength(rowsBefore)
    expect(composition.usage).toHaveLength(usageBefore)
  })
})
