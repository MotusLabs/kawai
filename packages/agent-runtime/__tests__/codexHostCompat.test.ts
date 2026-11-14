// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Codex driver's optional host-compatibility observations (owner
// amendment R2 of task-7811b455; design §5) through the public factory and the
// owned fake app-server. Expected values come from the fixture's own records
// (envs.jsonl, the frames its `/facts` script writes, its rateLimits modes),
// never from the driver:
// - onSpawn: one report per actual app-server construction, with that
//   process's cwd and environment, the caller's prompt append, effort and
//   model (null when omitted) and whether it resumes a saved thread.
// - onCompactionObservation: the completed boundary once per item id, with
//   the turn it came on; the app-server gives no start or sizes.
// - onContextUsage meta: the model-window fallback threshold source.
// - onQuotaNoData: a permitted account/rateLimits/read that is refused (a
//   missing method or an error) or answers no windows reports once with the
//   session's own login; a read with windows, a denied claim and a read that
//   the stop cancels report none.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { CompactionObservation, ContextUsageMeta, QuotaNoData, SpawnInfo } from '../src/options.js'
import type { ContextUsage, QuotaReport } from '../src/usage/types.js'
import { codexDriver, sent, stopDrivers, waitFor, type CodexRoot } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

/** What the fake app-server processes recorded about themselves, in spawn order. */
const spawned = (root: CodexRoot) =>
  readFileSync(join(root.home, 'envs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; cwd: string; env: Record<string, string> })

async function turn(h: { driver: { send(text: string): Promise<{ turnId: string; result: Promise<unknown> }> } }, text = 'go') {
  const handle = await h.driver.send(text)
  await handle.result
  return handle
}

const snapshot = (primary: unknown) => ({ limitId: null, limitName: null, primary, secondary: null, credits: null, planType: null, rateLimitReachedType: null })

describe('Codex spawn provenance', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test('each actual app-server construction reports its own cwd, environment, caller inputs and resume', async () => {
    const spawns: SpawnInfo[] = []
    const h = codexDriver({ model: 'model-x', effort: 'high', systemPromptAppend: 'HOST APPEND', callbacks: { onSpawn: (info) => spawns.push(info) } })
    expect(spawns).toEqual([])
    await h.driver.start()
    await turn(h, '/exit 1')
    await waitFor(() => h.ends.length === 1)
    await h.driver.start()
    const processes = spawned(h.root)
    expect(processes).toHaveLength(2)
    expect(spawns.map((s) => [s.generation, s.resumed, s.systemPromptAppend, s.effort, s.model])).toEqual([
      [1, false, 'HOST APPEND', 'high', 'model-x'],
      [2, true, 'HOST APPEND', 'high', 'model-x'],
    ])
    for (const [index, info] of spawns.entries()) {
      expect(info.cwd).toBe(processes[index]!.cwd)
      // Every variable the report names is what that process really got.
      for (const [key, value] of Object.entries(info.childEnv)) expect([key, processes[index]!.env[key]]).toEqual([key, value])
      expect(info.childEnv.CODEX_HOME).toBe(h.root.home)
    }
  })

  test('omitted inputs are null and an empty append', async () => {
    const spawns: SpawnInfo[] = []
    const h = codexDriver({ callbacks: { onSpawn: (info) => spawns.push(info) } })
    await h.driver.start()
    expect(spawns.map((s) => [s.systemPromptAppend, s.effort, s.model, s.resumed])).toEqual([['', null, null, false]])
  })
})

describe('Codex compaction and context observations', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test('a boundary is observed once per item on its turn, beside the unchanged onCompaction; context readings name their threshold source', async () => {
    const observations: CompactionObservation[] = []
    const compactions: string[] = []
    const contexts: Array<[ContextUsage | null, ContextUsageMeta | undefined]> = []
    const h = codexDriver({
      callbacks: {
        onCompactionObservation: (o) => observations.push(o),
        onCompaction: (c) => compactions.push(c.boundaryId),
        onContextUsage: (usage, meta) => contexts.push([usage, meta]),
      },
    })
    await h.driver.start()
    const handle = await turn(h, '/facts')
    expect(compactions).toEqual(['cmp-1'])
    expect(observations).toHaveLength(1)
    const [observed] = observations
    expect({ ...observed, endedAt: typeof observed!.endedAt }).toEqual({
      trigger: 'auto', startedAt: null, endedAt: 'string', preTokens: null, postTokens: null, durationSeconds: null,
      outcome: 'completed', sourceId: 'boundary:cmp-1', turnId: handle.turnId,
    })
    // The fixture's last breakdown: 100 input + 50 output of a 1000-token window.
    expect(contexts.map(([usage, meta]) => [usage?.usedTokens, usage?.thresholdTokens, meta])).toEqual([[150, 1000, { thresholdSource: 'model-window-fallback' }]])
  })
})

describe('Codex quota no-data', () => {
  const run = async (mode: string | undefined, claim: boolean | undefined) => {
    const noData: QuotaNoData[] = []
    const quotas: QuotaReport[] = []
    const h = codexDriver({
      env: mode === undefined ? {} : { FAKE_CODEX_RATELIMITS: mode },
      ...(claim === undefined ? {} : { claimRateLimitsRead: () => claim }),
      callbacks: { onQuotaNoData: (info) => noData.push(info), onQuotaReport: (q) => quotas.push(q) },
    })
    await h.driver.start()
    // Native prompt exchanges are the barriers: the read is sent at readiness and answered before these results.
    await turn(h, 'barrier 1')
    await turn(h, 'barrier 2')
    return { h, noData, quotas: quotas.filter((q) => q.source === 'report'), reads: sent(h.root, 'account/rateLimits/read').length }
  }
  const SESSION: QuotaNoData = { source: 'report', accountScope: 'session' }

  // @covers: agent-runtime › Usage and quota reports remain observable › Quota read yields no data
  test.each([
    ['a missing method (-32601)', undefined, true],
    ['an error answer', 'fail', true],
    ['a reply with no windows', JSON.stringify(snapshot(null)), true],
    ['a missing method on the omitted-claim read', undefined, undefined],
  ] as const)('%s: one no-data report for the session login, no quota report', async (_name, mode, claim) => {
    const { noData, quotas, reads } = await run(mode, claim)
    expect(reads).toBe(1)
    expect(noData).toEqual([SESSION])
    expect(quotas).toEqual([])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Quota read yields no data
  test('a read with windows reports the quota and no no-data', async () => {
    const { noData, quotas, reads } = await run(JSON.stringify(snapshot({ usedPercent: 33, windowDurationMins: 300, resetsAt: 1900000000 })), true)
    expect(reads).toBe(1)
    expect(noData).toEqual([])
    expect(quotas.map((q) => q.windows[0]?.percentUsed)).toEqual([33])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Quota read yields no data
  test('a denied claim attempts nothing and reports no no-data', async () => {
    const { noData, reads } = await run(undefined, false)
    expect(reads).toBe(0)
    expect(noData).toEqual([])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Quota read yields no data
  test('a read the stop cancels is not no-data', async () => {
    const noData: QuotaNoData[] = []
    const h = codexDriver({ env: { FAKE_CODEX_RATELIMITS: 'hold' }, claimRateLimitsRead: () => true, callbacks: { onQuotaNoData: (info) => noData.push(info) } })
    await h.driver.start()
    await waitFor(() => sent(h.root, 'account/rateLimits/read').length === 1)
    await h.driver.kill()
    expect(noData).toEqual([])
  })
})
