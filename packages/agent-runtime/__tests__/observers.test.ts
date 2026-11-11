// @reads: packages/agent-runtime/__tests__/fixtures/**
// I8 for usage observers (task 5.4; P15/R11): over 128 seeded paired traces
// per provider, the same production trace runs with its usage observers
// absent, present and throwing. In the throwing run every usage observer
// (limits, quota, context, compaction, model) and the event and result sinks
// record, then throw their own Error. Optional observation never changes
// execution:
// - every run's results (outcome, tokens, counts, Claude's model and cost)
//   equal the reference model's, so all three are equal;
// - the throwing run reports the same limit/wait and quota sequence as the
//   recording one;
// - no observer, present or throwing, fails a turn or the stop's own work: the
//   absent and present stops resolve, and the throwing stop rejects with
//   exactly the thrown Errors, each once, as raw causes (nothing lost,
//   swallowed or duplicated).
// The traces are helpers/usageStreams.ts (the I7 generators); the existing
// tool-observer I8 (integrations.test.ts) keeps its own 128 traces.
// R11 also: no observer throw becomes an unhandled rejection; and with an
// observer throw in a body and another in the stop's own cleanup (a wait the
// stop ends, the interrupted turn's result), the turn still settles and the
// stop reports both, each once (body and cleanup errors together).
// M-observer controls: a notify that swallows a throw, or one that lets it
// abort the frame (skipping the rest of that frame's settlement), must fail.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createClaudeDriver } from '../src/claude/index.js'
import type { AgentRuntimeError } from '../src/errors.js'
import { codexDriver, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'
import { claudeStream, codexStream, type StreamRun } from './helpers/usageStreams.js'

afterEach(stopDrivers)

const unhandled: unknown[] = []
const record = (reason: unknown) => void unhandled.push(reason)
beforeAll(() => void process.on('unhandledRejection', record))
afterAll(() => void process.off('unhandledRejection', record))

const OBSERVERS = ['onLimitEvent', 'onQuotaReport', 'onContextUsage', 'onCompaction', 'onModel', 'onEvent', 'onTurnResult']
/** The observers that threw, per provider, over all traces (for the coverage check). */
const threw = { claude: new Set<string>(), codex: new Set<string>() }

async function paired(stream: (seed: number, mode: 'absent' | 'present' | 'throwing', base: number) => Promise<StreamRun>, seed: number, into: Set<string>): Promise<string[]> {
  // One clock origin for the three runs, so their announced reset times agree.
  const base = Math.floor(Date.now() / 1000)
  const absent = await stream(seed, 'absent', base)
  const present = await stream(seed, 'present', base)
  const violations: string[] = []
  let throwing: StreamRun
  try {
    throwing = await stream(seed, 'throwing', base)
  } catch (error) {
    // A driver call (start, send, a turn result) rejected: an observer's throw escaped into execution.
    return [`the throwing run aborted: ${error instanceof Error ? error.message : String(error)}`]
  }
  for (const [name, run] of [['absent', absent], ['present', present], ['throwing', throwing]] as const) {
    for (const violation of run.violations) violations.push(`${name}: ${violation}`)
  }
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) violations.push(`${what} differ: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
  same('results absent/present', absent.results, present.results)
  same('results present/throwing', present.results, throwing.results)
  same('limits present/throwing', present.limits, throwing.limits)
  same('quotas present/throwing', present.quotas, throwing.quotas)
  if (absent.stopCauses !== null) violations.push(`absent stop rejected: ${absent.stopCauses.length} causes`)
  if (present.stopCauses !== null) violations.push(`present stop rejected: ${present.stopCauses.length} causes`)
  const causes = throwing.stopCauses ?? []
  for (const error of throwing.thrown) into.add(error.message.split(' ')[0]!)
  if (throwing.thrown.length === 0) violations.push('the throwing run threw nothing')
  for (const error of throwing.thrown) {
    const reported = causes.filter((cause) => cause === error).length
    if (reported !== 1) violations.push(`${error.message} reported ${reported} times`)
  }
  if (causes.length !== throwing.thrown.length) violations.push(`stop reported ${causes.length} causes for ${throwing.thrown.length} throws`)
  return violations
}

describe('I8: usage observers absent, present or throwing never change execution', () => {
  // 0xA608, 128 paired traces per provider, in slices so each test stays within its timeout.
  for (let slice = 0; slice < 4; slice++) {
    test(`Claude: paired traces ${slice * 32}-${slice * 32 + 31} settle the same facts; every throw is reported once`, async () => {
      const failures: string[] = []
      for (let i = slice * 32; i < slice * 32 + 32; i++) {
        const violations = await paired(claudeStream, 0xa608 + i * 7919, threw.claude)
        if (violations.length > 0) failures.push(`trace ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
    })
  }
  for (let slice = 0; slice < 32; slice++) {
    test(`Codex: paired traces ${slice * 4}-${slice * 4 + 3} settle the same facts; every throw is reported once`, async () => {
      const failures: string[] = []
      for (let i = slice * 4; i < slice * 4 + 4; i++) {
        const violations = await paired(codexStream, 0xa608 + i * 7919, threw.codex)
        if (violations.length > 0) failures.push(`trace ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
    })
  }
  test('every usage observer and sink threw in some trace of each provider', () => {
    expect(OBSERVERS.filter((name) => !threw.claude.has(name))).toEqual([])
    expect(OBSERVERS.filter((name) => !threw.codex.has(name))).toEqual([])
  })
  test('no observer throw became an unhandled rejection', () => {
    expect(unhandled).toEqual([])
  })
})

/** Observers that record, then throw a fresh Error each call; `duringStop` counts the throws after the stop began. */
function throwingObservers() {
  const thrown: Error[] = []
  const limits: string[] = []
  let stopping = false
  let duringStop = 0
  const fail = (name: string) => {
    const error = new Error(`${name} throw ${thrown.length + 1}`)
    thrown.push(error)
    if (stopping) duringStop++
    throw error
  }
  return {
    thrown,
    limits,
    stopping: () => void (stopping = true),
    duringStop: () => duringStop,
    callbacks: {
      onEvent: () => fail('onEvent'),
      onTurnResult: () => fail('onTurnResult'),
      onLimitEvent: (event: { type: string }) => {
        limits.push(event.type)
        fail('onLimitEvent')
      },
    },
  }
}

async function stopCauses(stop: Promise<unknown>): Promise<unknown[] | null> {
  try {
    await stop
    return null
  } catch (error) {
    return [...((error as AgentRuntimeError).causes ?? [error])]
  }
}

describe('R11: observer throws in a body and in the stop\'s own cleanup are reported together', () => {
  const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 10, error_status: 429, error: 'rate_limit' }

  test('Claude: a held turn\'s wait and result settle through throwing observers; the kill reports every throw once', async () => {
    const o = throwingObservers()
    const silent = () => {}
    const d = createClaudeDriver({
      launch: fakeClaudeHome().launch(),
      logger: { debug: silent, info: silent, warn: silent, error: silent },
      permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] },
      callbacks: o.callbacks,
    })
    await d.start()
    const handle = await d.send(`script ${JSON.stringify({ frames: [{ ...retry, uuid: crypto.randomUUID() }], hold: true })}`)
    await waitFor(() => o.limits.includes('wait-start'))
    o.stopping()
    const causes = await stopCauses(d.kill())
    expect((await handle.result).outcome).toBe('interrupted')
    expect(o.limits).toEqual(['failure', 'wait-start', 'wait-end'])
    expect(o.duringStop()).toBeGreaterThan(0)
    expect(o.thrown.length).toBeGreaterThan(o.duringStop())
    expect(causes).not.toBeNull()
    expect(o.thrown.map((error) => causes!.filter((cause) => cause === error).length)).toEqual(o.thrown.map(() => 1))
    expect(causes!.length).toBe(o.thrown.length)
  })

  test('Codex: a held turn\'s wait and result settle through throwing observers; the kill reports every throw once', async () => {
    const o = throwingObservers()
    const h = codexDriver({ callbacks: o.callbacks })
    await h.driver.start()
    const note = { method: 'error', params: { willRetry: true, error: { message: 'retrying', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null } } }
    const handle = await h.driver.send(`/script ${JSON.stringify({ notes: [note], end: 'hold' })}`)
    await waitFor(() => o.limits.includes('wait-start'))
    o.stopping()
    const causes = await stopCauses(h.driver.kill())
    expect((await handle.result).outcome).toBe('interrupted')
    expect(o.limits).toEqual(['failure', 'wait-start', 'wait-end'])
    expect(o.duringStop()).toBeGreaterThan(0)
    expect(o.thrown.length).toBeGreaterThan(o.duringStop())
    expect(causes).not.toBeNull()
    expect(o.thrown.map((error) => causes!.filter((cause) => cause === error).length)).toEqual(o.thrown.map(() => 1))
    expect(causes!.length).toBe(o.thrown.length)
  })
})
