// The narrow SDK-cleanup exception, row by row (task-d6bf9929 R3 A4/A6/A8):
// one real genuine query over a pipe process per row, one control
// invocation, then a stop-like sample, token and close done by hand, so each
// condition is varied alone. Rows that refuse must leave the projections
// empty. The account table checks that the stop's native account keeps
// projections raw: by identity, in order, duplicates and nils included, and
// only when the (CONTROLLED, frozen) native verdict failed.
import { describe, expect, test } from 'bun:test'
import { AbortError, type Options, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { accountGenerations, loadSdk, newGeneration, type Generation, type SdkModule } from '../src/claude/generations.js'
import { CLEANUP_TEXT, ControlInvocation, genuineQuery, isCleanupError, sampleCleanupAtStop } from '../src/claude/sdkControlCleanup.js'
import { AgentRuntimeError } from '../src/errors.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import type { OwnedProcess } from '../src/process/ownedProcess.js'
import { PipeProcess, controlledOwner, release } from './helpers/sdkPipeProcess.js'

type Build = 'genuine' | 'plain-query' | 'copied-namespace'

interface Fixture {
  sdk: SdkModule
  process: PipeProcess
  generation: Generation
  done(): Promise<void>
}

async function fixture(build: Build = 'genuine', number = 1): Promise<Fixture> {
  const sdk = await loadSdk()
  const process = new PipeProcess()
  const generation = newGeneration(number, sdk, null)
  const options = { abortController: generation.abort, pathToClaudeCodeExecutable: '/nonexistent/claude', settingSources: [], spawnClaudeCodeProcess: () => process as unknown as SpawnedProcess } as Options
  const params = { prompt: generation.input, options }
  generation.query = build === 'genuine' ? genuineQuery(sdk, params) : build === 'plain-query' ? sdk.query(params) : genuineQuery({ ...sdk }, params)
  await generation.query.initializationResult()
  return {
    sdk, process, generation,
    done: async () => {
      generation.input.end()
      await release(process, generation.query)
    },
  }
}

/** Start one context-probe invocation and wait until the SDK wrote its request. */
async function probe(fx: Fixture): Promise<{ invocation: ControlInvocation; settled: Promise<unknown> }> {
  const invocation = new ControlInvocation(fx.generation, 'context-probe')
  const settled = invocation.call({ detail: 'summary' }).then(() => 'resolved', (error: unknown) => error)
  await fx.process.control('get_context_usage')
  return { invocation, settled }
}

/** The stop's order: sample, then abort with the token, then our close (or a cause-bearing cleanup). */
function stop(generation: Generation, token: object, cause?: unknown): void {
  sampleCleanupAtStop([generation])
  if (!generation.abort.signal.aborted) generation.abort.abort(token)
  if (cause === undefined) generation.query.close()
  else (generation.query as unknown as { cleanup(cause: unknown): void }).cleanup(cause)
}

describe('the SDK cleanup exception, one condition at a time', () => {
  test('the baseline row: a trusted probe cut by our close after the sample and token is the cancellation, kept once', async () => {
    const fx = await fixture()
    try {
      const { invocation, settled } = await probe(fx)
      const token = {}
      stop(fx.generation, token)
      const error = await settled
      expect(isCleanupError(error)).toBe(true)
      expect(fx.generation.cleanupAtStop).toBe(false)
      expect(fx.generation.exitedAtStop).toBe(false)
      expect(invocation.cancelledByCleanup(token, error)).toBe(true)
      expect(fx.generation.projections).toEqual([error])
      expect(fx.generation.projections[0]).toBe(error)
    } finally {
      await fx.done()
    }
  })

  const refusals: Array<{ name: string; build?: Build; arrange?(fx: Fixture): void; act?(fx: Fixture, token: object): void; ask?(fx: Fixture, error: unknown, token: object): [object | null, unknown] }> = [
    { name: 'no token', ask: (_, error) => [null, error] },
    { name: 'a wrong token', ask: (_, error) => [{}, error] },
    { name: 'a caller abort first (the stop token is not the reason)', act: (fx, token) => { fx.generation.abort.abort(new Error('caller')); stop(fx.generation, token) } },
    { name: 'an unsampled generation', act: (fx, token) => { fx.generation.abort.abort(token); fx.generation.query.close() } },
    { name: 'a cleanup begun before the sample', act: (fx, token) => { fx.generation.query.close(); stop(fx.generation, token) } },
    { name: 'an unknown sample', act: (fx, token) => { stop(fx.generation, token); fx.generation.cleanupAtStop = 'unknown' } },
    { name: 'an owner exit (code 0) observed before the sample', arrange: (fx) => void (fx.generation.owned = controlledOwner(1, { before: { kind: 'exited', code: 0, signal: null } }) as unknown as OwnedProcess) },
    { name: 'a cause-bearing cleanup', act: (fx, token) => stop(fx.generation, token, new Error(CLEANUP_TEXT)) },
    { name: 'a replaced probe method', arrange: (fx) => { const real = fx.generation.query.getContextUsage; (fx.generation.query as unknown as Record<string, unknown>).getContextUsage = function (this: unknown) { return real.call(this) } } },
    { name: 'a plain sdk.query (queryFactory) query', build: 'plain-query' },
    { name: 'a query from a copied, not imported, SDK namespace', build: 'copied-namespace' },
    { name: 'an exact-text error that is not its rejection', ask: (_, __, token) => [token, new Error(CLEANUP_TEXT)] },
    { name: 'a query swapped on the generation after the call', ask: (fx, error, token) => { fx.generation.query = { ...fx.generation.query } as typeof fx.generation.query; return [token, error] } },
  ]

  for (const row of refusals) {
    test(`refused: ${row.name}`, async () => {
      const fx = await fixture(row.build)
      const query = fx.generation.query
      try {
        row.arrange?.(fx)
        const { invocation, settled } = await probe(fx)
        const token = {}
        if (row.act) row.act(fx, token)
        else stop(fx.generation, token)
        const error = await settled
        expect(error).toBeInstanceOf(Error)
        const [askToken, askError] = row.ask ? row.ask(fx, error, token) : [token, error]
        expect(invocation.cancelledByCleanup(askToken, askError)).toBe(false)
        expect(fx.generation.projections).toEqual([])
      } finally {
        fx.generation.query = query
        await fx.done()
      }
    })
  }

  test('refused: another generation\'s invocation never accepts this generation\'s cleanup error', async () => {
    const one = await fixture('genuine', 1)
    const two = await fixture('genuine', 2)
    try {
      const first = await probe(one)
      const second = await probe(two)
      const token = {}
      stop(one.generation, token)
      stop(two.generation, token)
      const [a, b] = await Promise.all([first.settled, second.settled])
      expect(a).not.toBe(b)
      expect(second.invocation.cancelledByCleanup(token, a)).toBe(false)
      expect(first.invocation.cancelledByCleanup(token, b)).toBe(false)
      expect(one.generation.projections).toEqual([])
      expect(two.generation.projections).toEqual([])
    } finally {
      await one.done()
      await two.done()
    }
  })

  test('the sample is taken once, reads unknown for a missing or foreign query, and never defaults to false', async () => {
    const fx = await fixture('plain-query')
    try {
      const missing = newGeneration(2, fx.sdk, null)
      sampleCleanupAtStop([fx.generation, missing])
      expect(fx.generation.cleanupAtStop).toBe('unknown')
      expect(missing.cleanupAtStop).toBe('unknown')
      expect(missing.exitedAtStop).toBe(false)
      expect(new ControlInvocation(missing, 'interrupt').method()).toBeUndefined()
      // A repeated (memoized or reentrant) sample keeps the first.
      missing.owned = controlledOwner(2, { before: { kind: 'exited', code: 0, signal: null } }) as unknown as OwnedProcess
      sampleCleanupAtStop([missing])
      expect(missing.exitedAtStop).toBe(false)
    } finally {
      await fx.done()
    }
  })
})

describe('exactly the SDK plain cleanup error', () => {
  const near = (build: (e: Error) => void, base: () => Error = () => new Error(CLEANUP_TEXT)) => {
    const error = base()
    build(error)
    return error
  }
  class Sub extends Error {}
  const rows: Array<[string, unknown, boolean]> = [
    ['the plain error', new Error(CLEANUP_TEXT), true],
    ['a trailing space', new Error(`${CLEANUP_TEXT} `), false],
    ['another text', new Error('Operation aborted'), false],
    ['a subclass', new Sub(CLEANUP_TEXT), false],
    ['the SDK AbortError with the text', new AbortError(CLEANUP_TEXT), false],
    ['a TypeError with the text', new TypeError(CLEANUP_TEXT), false],
    ['an own cause, even undefined', new Error(CLEANUP_TEXT, { cause: undefined }), false],
    ['an own name', near((e) => (e.name = 'Error')), false],
    ['a telemetry tag', near((e) => Object.assign(e, { telemetryMessage: CLEANUP_TEXT })), false],
    ['an error class tag', near((e) => Object.assign(e, { errorClass: 'aborted' })), false],
    ['an error code', near((e) => Object.assign(e, { errorCode: 'x' })), false],
    ['a message-only object', { message: CLEANUP_TEXT, name: 'Error' }, false],
    ['undefined', undefined, false],
    ['null', null, false],
  ]
  for (const [name, error, expected] of rows) {
    test(`${expected ? 'accepted' : 'refused'}: ${name}`, () => {
      expect(isCleanupError(error)).toBe(expected)
    })
  }
})

describe('the stop account keeps projections raw', () => {
  const a = new Error(CLEANUP_TEXT)
  const b = new AbortError('Claude Code process aborted by user')
  const nested = new AgentRuntimeError({ category: 'transport', message: 'nested' }, [a])
  const sets: Array<[string, unknown[]]> = [
    ['zero', []],
    ['one', [a]],
    ['multiple in order', [b, a]],
    ['duplicates', [a, a]],
    ['nils', [undefined, null]],
    ['nested', [nested, a]],
  ]
  for (const [name, projections] of sets) {
    test(`a failed controlled exit nests ${name} by identity; a clean one reports none`, async () => {
      const sdk = await loadSdk()
      const failed = newGeneration(1, sdk, null)
      failed.owned = controlledOwner(1, { before: { kind: 'exited', code: 143, signal: null } }) as unknown as OwnedProcess
      failed.projections.push(...projections)
      const clean = newGeneration(2, sdk, null)
      clean.owned = controlledOwner(2, { before: { kind: 'exited', code: 0, signal: null } }) as unknown as OwnedProcess
      clean.projections.push(...projections)
      const causes = accountGenerations([failed, clean])
      expect(causes).toHaveLength(1)
      const native = causes[0] as NativeExitFailure
      expect(native).toBeInstanceOf(NativeExitFailure)
      expect(native.causes).toHaveLength(projections.length)
      for (const [i, projection] of projections.entries()) expect(native.causes[i]).toBe(projection)
    })
  }
})
