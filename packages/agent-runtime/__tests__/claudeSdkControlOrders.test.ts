// The pinned SDK's pending-control cleanup across every control the session
// sends without an abort signal (task-d6bf9929 R3 A3/A6/A7/A8): the context
// probe, the interrupt, the host-login usage pull and initialize. The pipe
// cases run the real SDK over in-memory pipes with no owned process, so they
// prove control cancellation and its identity only, never a native exit; a
// CONTROLLED owner, where one is installed, supplies evidence the test froze.
// Close first, EOF first and exit first are each driven deterministically.
import { describe, expect, test } from 'bun:test'
import { AbortError, type Query } from '@anthropic-ai/claude-agent-sdk'
import { CLEANUP_TEXT } from '../src/claude/sdkControlCleanup.js'
import { ClaudeSession, type ClaudeQueryFactory } from '../src/claude/session.js'
import type { ClaudeSessionOptions } from '../src/claude/sessionOptions.js'
import { AgentRuntimeError } from '../src/errors.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'
import { controlledOwner, genuinePipeQueries, release, type GenuinePipeQueries } from './helpers/sdkPipeProcess.js'

interface GenerationView {
  projections: unknown[]
  readEnded: boolean
  cleanupAtStop: unknown
  exitedAtStop: unknown
  owned: unknown
}

const generationsOf = (s: ClaudeSession) => (s as unknown as { generations: GenerationView[] }).generations
const cleanupOf = (query: Query) => query as unknown as { cleanupPerformed: unknown; cleanupCause: unknown; addCleanupCallback(callback: () => void): void }
const jobsOf = (s: ClaudeSession) => (s as unknown as { lifecycle: { jobs: { run(label: string, body: () => Promise<unknown>): Promise<unknown> } } }).lifecycle.jobs

function pipeSession(factory: ClaudeQueryFactory, extra: Partial<ClaudeSessionOptions> = {}): ClaudeSession {
  return new ClaudeSession({ launch: fakeClaudeHome().launch(), callbacks: { onEvent: () => {} }, terminate: { graceMs: 50, killMs: 1000 }, queryFactory: factory, ...extra })
}

async function failure(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected a failure')
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function isCleanupError(error: unknown): boolean {
  return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && error.message === CLEANUP_TEXT && !Object.hasOwn(error, 'cause')
}

/** Every projection is the one object `cut`, `count` times (no deduplication). */
function sameCut(projections: unknown[], count: number): unknown {
  expect(projections).toHaveLength(count)
  for (const projection of projections) expect(projection).toBe(projections[0])
  return projections[0]
}

async function releaseAll(pipes: GenuinePipeQueries): Promise<void> {
  for (const [i, process] of pipes.processes.entries()) await release(process, pipes.queries[i]!)
}

const pending = (subtype: string) => (pipes: GenuinePipeQueries) => (pipes.processes[0]?.controls ?? []).filter((frame) => frame.request.subtype === subtype).length

describe('pinned SDK cleanup of every unsignalled control after a stop', () => {
  // @covers: agent-runtime › Forced stop has an actual exit boundary › Pending provider control cut by the stop
  test('close first: a pending interrupt and both context probes share one cleanup error, each kept by identity', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      const handle = await s.send('hello')
      expect((await s.interrupt()).outcome).toBe('requested')
      await handle.result
      await until(() => pending('get_context_usage')(pipes) === 2 && pending('interrupt')(pipes) === 1)
      const receipt = await s.kill()
      expect(receipt.js).toBe('settled')
      const query = cleanupOf(pipes.queries[0]!)
      expect(query.cleanupPerformed).toBe(true)
      expect(query.cleanupCause).toBeUndefined()
      expect(isCleanupError(sameCut(generationsOf(s)[0]!.projections, 3))).toBe(true)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('close first: a pending host-login usage pull and context probe share one cleanup error', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory, { quotaSource: 'host-login' })
    try {
      await s.start()
      await until(() => pending('get_context_usage')(pipes) === 1 && pending('get_usage')(pipes) + pending('usage')(pipes) >= 1)
      expect((await s.kill()).js).toBe('settled')
      expect(isCleanupError(sameCut(generationsOf(s)[0]!.projections, 2))).toBe(true)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('close first: a claimed usage pull is the cancellation, but the claim rejecting the cleanup text is a failure', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory, { quotaSource: 'host-login', claimUsagePull: () => true })
    try {
      await s.start()
      await until(() => pipes.processes[0]!.controls.length >= 3)
      expect((await s.kill()).js).toBe('settled')
      expect(isCleanupError(sameCut(generationsOf(s)[0]!.projections, 2))).toBe(true)
    } finally {
      await releaseAll(pipes)
    }
    const held = await genuinePipeQueries()
    const independent = new Error(CLEANUP_TEXT)
    let reject!: (error: unknown) => void
    held.onQuery = (query) => cleanupOf(query).addCleanupCallback(() => reject(independent))
    const claimed = pipeSession(held.factory, { quotaSource: 'host-login', claimUsagePull: () => new Promise<boolean>((_, r) => (reject = r)) })
    try {
      await claimed.start()
      await until(() => pending('get_context_usage')(held) === 1)
      const error = await failure(claimed.kill())
      expect(error.causes).toEqual([independent])
      expect(error.causes[0]).toBe(independent)
      // Only the probe's own rejection is a projection; the claim never reached the SDK pull.
      expect(isCleanupError(sameCut(generationsOf(claimed)[0]!.projections, 1))).toBe(true)
      expect(generationsOf(claimed)[0]!.projections[0]).not.toBe(independent)
    } finally {
      await releaseAll(held)
    }
  })

  test('close first: a start whose initialize is pending is cancelled by the stop, its cleanup error kept by identity', async () => {
    const pipes = await genuinePipeQueries({ holdInitialize: true })
    const s = pipeSession(pipes.factory)
    try {
      const started = s.start()
      await until(() => pipes.processes.length === 1 && pending('initialize')(pipes) === 1)
      expect((await s.kill()).js).toBe('settled')
      const refused = await failure(started)
      expect(refused.category).toBe('stopped')
      const cut = sameCut(generationsOf(s)[0]!.projections, 1)
      expect(isCleanupError(cut)).toBe(true)
      expect(refused.causes).toEqual([cut])
      expect(refused.causes[0]).toBe(cut)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('exit first: the process exits at the abort before its stdout ends, and the SDK AbortError is the one cut kept', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    let let_go!: () => void
    const held = new Promise<void>((resolve) => (let_go = resolve))
    try {
      await s.start()
      const process = pipes.processes[0]!
      await process.control('get_context_usage')
      // CONTROLLED owner: alive at the sample; its termination waits until the SDK's own cleanup ran.
      generationsOf(s)[0]!.owned = controlledOwner(1, { atStop: { kind: 'exited', code: null, signal: 'SIGKILL' } }, held)
      process.onKill = (signal) => {
        process.exit(null, signal)
        process.stdout.end()
      }
      const stop = s.kill()
      const query = cleanupOf(pipes.queries[0]!)
      await until(() => query.cleanupPerformed === true)
      let_go()
      expect((await stop).js).toBe('settled')
      expect(query.cleanupCause).toBeInstanceOf(AbortError)
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(false)
      expect(generation!.readEnded).toBe(true)
      // The stream's read failure and the probe: one object, twice.
      expect(sameCut(generation!.projections, 2)).toBe(query.cleanupCause)
      expect(process.stdout.readableEnded).toBe(true)
    } finally {
      let_go()
      await releaseAll(pipes)
    }
  })

  // @covers: agent-runtime › Forced stop has an actual exit boundary › Pending provider control cut by the stop
  test('EOF first: stdout ends at the abort and the exit is code 0, so the SDK cleanup error after the token is the cancellation', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    let let_go!: () => void
    const held = new Promise<void>((resolve) => (let_go = resolve))
    try {
      await s.start()
      const process = pipes.processes[0]!
      await process.control('get_context_usage')
      generationsOf(s)[0]!.owned = controlledOwner(1, { atStop: { kind: 'exited', code: null, signal: 'SIGKILL' } }, held)
      // The leader ended with code 0 (exitCode reads it), its stdout EOF comes first, its exit event later.
      process.onKill = () => {
        process.exitCode = 0
        process.stdout.end()
        setTimeout(() => process.exit(0), 20)
      }
      const stop = s.kill()
      const query = cleanupOf(pipes.queries[0]!)
      await until(() => query.cleanupPerformed === true)
      let_go()
      expect((await stop).js).toBe('settled')
      // The SDK's own normal-end cleanup won: no cause, before our close.
      expect(query.cleanupCause).toBeUndefined()
      expect(process.exitCode).toBe(0)
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(false)
      expect(generation!.readEnded).toBe(true)
      const cut = sameCut(generation!.projections, 1) as Error
      expect(isCleanupError(cut)).toBe(true)
      expect(cut.stack).not.toContain('terminateGenerations')
      expect(process.stdout.readableEnded).toBe(true)
    } finally {
      let_go()
      await releaseAll(pipes)
    }
  })

  test('an EOF and a clean exit the owner observed before the stop leave the queued cleanup error a raw failure', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      const process = pipes.processes[0]!
      await process.control('get_context_usage')
      // CONTROLLED owner evidence: exit 0 observed; the stdout EOF is written but the SDK's cleanup is still queued.
      generationsOf(s)[0]!.owned = controlledOwner(1, { before: { kind: 'exited', code: 0, signal: null } })
      process.stdout.end()
      expect(cleanupOf(pipes.queries[0]!).cleanupPerformed).toBe(false)
      const error = await failure(s.kill())
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(false)
      expect(generation!.exitedAtStop).toBe(true)
      expect(generation!.projections).toEqual([])
      expect(error.causes).toHaveLength(1)
      expect(isCleanupError(error.causes[0])).toBe(true)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('a cleanup begun before the stop samples true, so a probe rejection handled after beginStop fails the stop', async () => {
    const pipes = await genuinePipeQueries()
    let stop: Promise<unknown> | null = null
    let s!: ClaudeSession
    pipes.onQuery = (query) => cleanupOf(query).addCleanupCallback(() => {
      // Inside the SDK's cleanup, before it rejects: the stop begins (from inside an owned job, so this caller is refused).
      stop = s.kill().catch(() => {})
    })
    s = pipeSession(pipes.factory)
    try {
      await s.start()
      await pipes.processes[0]!.control('get_context_usage')
      // A clean exit and EOF before any stop: the SDK's own cause-less cleanup begins.
      pipes.processes[0]!.exit(0)
      pipes.processes[0]!.stdout.end()
      await until(() => stop !== null)
      const error = await failure(s.kill())
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(true)
      expect(generation!.projections).toEqual([])
      expect(error.causes.filter(isCleanupError)).toHaveLength(1)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('an initialize rejected by a cleanup begun before the stop stays a transport start failure', async () => {
    const pipes = await genuinePipeQueries({ holdInitialize: true })
    let stop: Promise<unknown> | null = null
    let s!: ClaudeSession
    pipes.onQuery = (query) => cleanupOf(query).addCleanupCallback(() => {
      stop = s.kill().catch(() => {})
    })
    s = pipeSession(pipes.factory)
    try {
      const started = s.start()
      await until(() => pending('initialize')(pipes) === 1)
      pipes.processes[0]!.exit(0)
      pipes.processes[0]!.stdout.end()
      const refused = await failure(started)
      expect(stop).not.toBeNull()
      expect(refused.category).toBe('transport')
      expect(isCleanupError(refused.causes[0])).toBe(true)
      const error = await failure(s.kill())
      expect(error.causes).toContain(refused)
      expect(generationsOf(s)[0]!.cleanupAtStop).toBe(true)
      expect(generationsOf(s)[0]!.projections).toEqual([])
    } finally {
      await releaseAll(pipes)
    }
  })

  test('a caller abort before the stop takes the token, so the pending probe cut fails the stop', async () => {
    const pipes = await genuinePipeQueries()
    const caller = new AbortController()
    const s = pipeSession(pipes.factory, { sdkOptions: { abortController: caller } })
    try {
      await s.start()
      await pipes.processes[0]!.control('get_context_usage')
      caller.abort(new Error('caller'))
      const error = await failure(s.kill())
      expect(generationsOf(s)[0]!.projections).toEqual([])
      expect(error.causes.length).toBeGreaterThanOrEqual(1)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('a later job rethrowing the accepted cleanup error is a failure of that job, by the same identity', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      await pipes.processes[0]!.control('get_context_usage')
      // The test's own unchanged genuine call is rejected by the same cleanup with the same object.
      const own = pipes.queries[0]!.getContextUsage()
      void jobsOf(s).run('late-rethrow', async () => {
        try {
          await own
        } catch (error) {
          await tick()
          throw error
        }
      })
      const error = await failure(s.kill())
      const cut = sameCut(generationsOf(s)[0]!.projections, 1)
      expect(error.causes).toHaveLength(1)
      expect(error.causes[0]).toBe(cut)
    } finally {
      await releaseAll(pipes)
    }
  })

  test('a CLI error reply with the cleanup text after the token is a tagged failure, never the cancellation', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    let let_go!: () => void
    const held = new Promise<void>((resolve) => (let_go = resolve))
    try {
      await s.start()
      const process = pipes.processes[0]!
      const probe = await process.control('get_context_usage')
      // CONTROLLED owner: alive at the sample; its kill ends clean once the test lets it go.
      const owner = controlledOwner(1, { atStop: { kind: 'exited', code: null, signal: 'SIGKILL' } }, held)
      generationsOf(s)[0]!.owned = owner
      const stop = failure(s.kill())
      process.respondError(probe, CLEANUP_TEXT)
      await tick()
      let_go()
      const error = await stop
      expect(error.causes).toHaveLength(1)
      const tagged = error.causes[0] as Error & { telemetryMessage?: unknown }
      expect(tagged.message).toBe(CLEANUP_TEXT)
      expect(isCleanupError(tagged) && !Object.hasOwn(tagged, 'telemetryMessage') && !Object.hasOwn(tagged, 'errorClass')).toBe(false)
      expect(generationsOf(s)[0]!.projections).toEqual([])
    } finally {
      let_go()
      await releaseAll(pipes)
    }
  })

  test('held peers of a stop stay pending until it settles and then share its success or its failure', async () => {
    for (const end of [{ code: null, signal: 'SIGKILL' as const, ok: true }, { code: 143, signal: null, ok: false }]) {
      const pipes = await genuinePipeQueries()
      const s = pipeSession(pipes.factory)
      let let_go!: () => void
      const held = new Promise<void>((resolve) => (let_go = resolve))
      try {
        await s.start()
        await pipes.processes[0]!.control('get_context_usage')
        generationsOf(s)[0]!.owned = controlledOwner(1, { atStop: { kind: 'exited', code: end.code, signal: end.signal } }, held)
        const first = s.kill()
        const peers = [s.kill(), s.shutdown()]
        const settled: unknown[] = []
        for (const p of [first, ...peers]) p.then((v) => settled.push(v), (e) => settled.push(e))
        await tick()
        expect(settled).toEqual([])
        let_go()
        for (const p of peers) expect(p).toBe(first)
        const outcome = await first.then((v) => v, (e: unknown) => e)
        await tick()
        expect(settled).toHaveLength(3)
        for (const v of settled) expect(v).toBe(outcome)
        // A repeated stop after it settled is the same memoized outcome.
        expect(s.kill()).toBe(first)
        const cut = sameCut(generationsOf(s)[0]!.projections, 1)
        if (end.ok) expect((outcome as { js?: unknown }).js).toBe('settled')
        else {
          const native = (outcome as AgentRuntimeError).causes[0] as NativeExitFailure
          expect(native).toBeInstanceOf(NativeExitFailure)
          expect(native.causes).toEqual([cut])
          expect(native.causes[0]).toBe(cut)
        }
      } finally {
        let_go()
        await releaseAll(pipes)
      }
    }
  })
})
