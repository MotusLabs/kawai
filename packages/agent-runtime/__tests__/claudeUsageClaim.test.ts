// @reads: packages/agent-runtime/__tests__/fixtures/**
// The caller-claimed Claude usage pull (ClaudeDriverOptions.claimUsagePull,
// owner amendment R2 of task-7811b455; design §6) and onQuotaNoData, through
// the public factory, the real SDK and the owned fake CLI. The fake answers
// the get_usage control request from its own home's usage.json, else with
// rate_limits_available false; pulls are counted from the frames it received.
// - The claim is asked once per generation, after that generation's query
//   was constructed (after onSpawn) and before any pull.
// - true under host-login: one pull of that generation, reported
//   host-login-pull / host-login; a reply without windows reports no-data.
// - false: no pull and no no-data. true under quotaSource none: no pull.
// - A rejecting claim pulls nothing and its raw error is retained once for
//   the stop. A claim answered after the stop began pulls nothing.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { ClaudeDriverOptions, QuotaNoData } from '../src/options.js'
import type { QuotaReport } from '../src/usage/types.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
let driver: ClaudeAgentDriver | null = null
afterEach(async () => {
  await driver?.kill().catch(() => {})
  driver = null
})

function claimed(options: { claim: ClaudeDriverOptions['claimUsagePull']; quotaSource?: 'none' | 'host-login'; windows?: boolean }) {
  const home = fakeClaudeHome()
  const launch = home.launch()
  if (options.windows !== false) {
    mkdirSync(join(launch.homeDir, '.claude'), { recursive: true })
    writeFileSync(join(launch.homeDir, '.claude', 'usage.json'), JSON.stringify({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 37, resets_at: '2030-01-01T00:00:00.000Z' } } }))
  }
  const order: string[] = []
  const quotas: QuotaReport[] = []
  const noData: QuotaNoData[] = []
  const claim = options.claim
  const d = createClaudeDriver({
    launch, logger, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
    quotaSource: options.quotaSource ?? 'host-login',
    ...(claim ? { claimUsagePull: () => (order.push('claim'), claim()) } : {}),
    callbacks: {
      onEvent: () => {},
      onSpawn: (info) => void order.push(`spawn ${info.generation}`),
      onQuotaReport: (q) => void quotas.push(q),
      onQuotaNoData: (info) => void noData.push(info),
    },
  })
  driver = d
  const pulls = () => home.received().filter((f) => (f.request as { subtype?: unknown } | undefined)?.subtype === 'get_usage').length
  const barrier = async () => {
    // Native prompt exchanges are the barriers: the pull is asked at initialize, answered before these results.
    await (await d.send('native barrier 1')).result
    await (await d.send('native barrier 2')).result
  }
  return { d, order, quotas, noData, pulls, barrier, pulled: () => quotas.map((q) => [q.source, q.accountScope, q.windows.map((w) => [w.key, w.percentUsed])]) }
}

describe('Claude caller-claimed usage pull', () => {
  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Claude usage pull
  test('true under host-login: asked after the query exists, one pull per generation, reported as host-login', async () => {
    const h = claimed({ claim: () => true })
    await h.d.start()
    await h.barrier()
    expect([h.pulls(), h.pulled(), h.noData]).toEqual([1, [['host-login-pull', 'host-login', [['five_hour', 37]]]], []])
    // The CLI ends on its own; the next start is a new generation, asked again.
    await (await h.d.send('quit')).result
    await h.d.start()
    await h.barrier()
    expect(h.order).toEqual(['spawn 1', 'claim', 'spawn 2', 'claim'])
    expect(h.pulls()).toBe(2)
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Claude usage pull
  test('an async false permits no pull and no no-data', async () => {
    const h = claimed({ claim: async () => false })
    await h.d.start()
    await h.barrier()
    expect([h.order, h.pulls(), h.quotas, h.noData]).toEqual([['spawn 1', 'claim'], 0, [], []])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Claude usage pull
  test('true under quotaSource none: the claim is asked but no pull follows', async () => {
    const h = claimed({ claim: () => true, quotaSource: 'none' })
    await h.d.start()
    await h.barrier()
    expect([h.order, h.pulls(), h.quotas, h.noData]).toEqual([['spawn 1', 'claim'], 0, [], []])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Quota read yields no data
  test('a permitted pull that finds no windows reports one no-data for the host login', async () => {
    const h = claimed({ claim: () => true, windows: false })
    await h.d.start()
    await h.barrier()
    expect([h.pulls(), h.quotas, h.noData]).toEqual([1, [], [{ source: 'host-login-pull', accountScope: 'host-login' }]])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Claude usage pull
  test('a rejecting claim pulls nothing and its raw error is retained once for the stop', async () => {
    const boom = new Error('claim store down')
    const h = claimed({ claim: () => Promise.reject(boom) })
    await h.d.start()
    await h.barrier()
    expect([h.pulls(), h.noData]).toEqual([0, []])
    const stopped = await h.d.kill().then(() => null, (error: unknown) => error)
    driver = null
    expect(stopped).toBeInstanceOf(AgentRuntimeError)
    expect((stopped as AgentRuntimeError).category).toBe('stop')
    expect((stopped as AgentRuntimeError).causes).toEqual([boom])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Claude usage pull
  test('a claim answered after the stop began pulls nothing and reports no no-data', async () => {
    let release!: (value: boolean) => void
    const h = claimed({ claim: () => new Promise<boolean>((resolve) => (release = resolve)) })
    await h.d.start()
    while (!h.order.includes('claim')) await new Promise((resolve) => setTimeout(resolve, 5))
    const stop = h.d.kill()
    release(true)
    await stop
    driver = null
    expect([h.pulls(), h.quotas, h.noData]).toEqual([0, [], []])
  })
})
