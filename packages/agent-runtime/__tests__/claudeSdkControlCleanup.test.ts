// The pinned SDK's pending-control cleanup after a stop (task-d6bf9929 R2):
// the context probe carries no abort signal, so only the Query's cleanup
// settles it. When our Query.close() runs that cleanup first, the probe
// rejects with the SDK's plain cause-less Error, which a genuine query's
// unchanged probe call recognizes as the stop's cancellation (kept by
// identity in the generation's projections). A replaced probe method's
// same-text rejection stays a failure, and a failed native exit still
// reports the projections. The pipe-process cases run the real SDK with no
// owned process, so they prove control cancellation only (a CONTROLLED owner
// supplies frozen evidence where installed); the fake-CLI cases (kill,
// shutdown, trapped 3 and 143; R3) run the default owned composition, where
// either cleanup may win.
import { describe, expect, test } from 'bun:test'
import { AbortError, type Query } from '@anthropic-ai/claude-agent-sdk'
import { CLEANUP_TEXT } from '../src/claude/sdkControlCleanup.js'
import { ClaudeSession, type ClaudeQueryFactory } from '../src/claude/session.js'
import { AgentRuntimeError } from '../src/errors.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'
import { controlledOwner, genuinePipeQueries, release } from './helpers/sdkPipeProcess.js'

interface GenerationView {
  projections: unknown[]
  readEnded: boolean
  cleanupAtStop: unknown
  exitedAtStop: unknown
  owned: unknown
}

const generationsOf = (s: ClaudeSession) => (s as unknown as { generations: GenerationView[] }).generations
const cleanupOf = (query: Query) => query as unknown as { cleanupPerformed: unknown; cleanupCause: unknown }

function pipeSession(factory: ClaudeQueryFactory): ClaudeSession {
  return new ClaudeSession({ launch: fakeClaudeHome().launch(), callbacks: { onEvent: () => {} }, terminate: { graceMs: 50, killMs: 1000 }, queryFactory: factory })
}

async function stopFailure(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected the stop to fail')
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Exactly the pinned SDK's cause-less cleanup error. */
function isCleanupError(error: unknown): boolean {
  return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && error.message === CLEANUP_TEXT && !Object.hasOwn(error, 'cause')
}

describe('pinned SDK pending-control cleanup after a stop', () => {
  // @covers: agent-runtime › Forced stop has an actual exit boundary › Pending provider control cut by the stop
  test('a pending context probe that our close cuts after kill is the stop cancellation, kept once by identity', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      const process = pipes.processes[0]!
      const query = pipes.queries[0]!
      // The probe after initialize is registered with the SDK and left unanswered.
      const probe = await process.control('get_context_usage')
      expect(probe.request.subtype).toBe('get_context_usage')
      expect(cleanupOf(query).cleanupPerformed).toBe(false)
      const receipt = await s.kill()
      expect(receipt).toEqual({ scope: 'agent-processes', mode: 'kill', processes: [], js: 'settled' })
      // Close first won: the process neither exited nor ended its stdout, and the cleanup had no cause.
      expect(process.exitCode).toBeNull()
      expect(cleanupOf(query).cleanupPerformed).toBe(true)
      expect(cleanupOf(query).cleanupCause).toBeUndefined()
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(false)
      expect(generation!.readEnded).toBe(true)
      expect(generation!.projections).toHaveLength(1)
      const cut = generation!.projections[0] as Error
      expect(isCleanupError(cut)).toBe(true)
      expect(cut.stack).toContain('performCleanup')
      // Released after the receipt: the SDK's cleanup and its transport reader of this stdout both complete.
      await release(process, query)
      expect(process.stdout.readableEnded).toBe(true)
    } finally {
      for (const [i, process] of pipes.processes.entries()) await release(process, pipes.queries[i]!)
    }
  })

  // @covers: agent-runtime › Forced stop has an actual exit boundary › Pending provider control cut by the stop
  test('a replaced probe method rejecting the same text once the real cleanup began fails the stop with that error', async () => {
    const pipes = await genuinePipeQueries()
    const independent = new Error(CLEANUP_TEXT)
    let called = false
    pipes.onQuery = (query) => {
      let reject!: (error: unknown) => void
      const held = new Promise<never>((_, r) => (reject = r))
      const target = query as unknown as Record<string, unknown> & { addCleanupCallback(callback: () => void): void }
      target.getContextUsage = () => {
        called = true
        return held
      }
      // Rejected inside the SDK's own cause-less cleanup, after the stop token and a false sample.
      target.addCleanupCallback(() => reject(independent))
    }
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      await until(() => called)
      const error = await stopFailure(s.kill())
      expect(error.causes).toHaveLength(1)
      expect(error.causes[0]).toBe(independent)
      const [generation] = generationsOf(s)
      expect(generation!.cleanupAtStop).toBe(false)
      expect(cleanupOf(pipes.queries[0]!).cleanupPerformed).toBe(true)
      expect(cleanupOf(pipes.queries[0]!).cleanupCause).toBeUndefined()
      expect(generation!.projections).toEqual([])
    } finally {
      for (const [i, process] of pipes.processes.entries()) await release(process, pipes.queries[i]!)
    }
  })

  test('held probes cut at a shutdown that ends with a trapped 143 stay in the native failure, twice by one identity', async () => {
    const home = fakeClaudeHome()
    const s = new ClaudeSession({ launch: home.launch(), callbacks: { onEvent: () => {} }, terminate: { graceMs: 300, killMs: 3000 } })
    const probes = () => home.received().filter((frame) => (frame.request as { subtype?: string } | undefined)?.subtype === 'get_context_usage').length
    try {
      await s.start()
      await (await s.send('hold-controls get_context_usage')).result
      await (await s.send('trap143')).result
      // The initialize probe was answered; the probes after both results are held.
      await until(() => probes() === 3)
      const error = await stopFailure(s.shutdown())
      expect(error.causes).toHaveLength(1)
      const native = error.causes[0] as NativeExitFailure
      expect(native).toBeInstanceOf(NativeExitFailure)
      expect(native.facts).toMatchObject({ generation: 1, code: 143, signal: null, observedBeforeStop: false })
      // One cleanup rejects both held probes with one object. When the SDK's read path won, its AbortError
      // is that object and the stream's read failure is a third projection of it; when our close won, the
      // stream just ended and only the two probe cuts are kept. Either way nothing is deduplicated.
      const cut = native.causes[0]
      expect(cut instanceof AbortError || isCleanupError(cut)).toBe(true)
      expect(native.causes).toHaveLength(cut instanceof AbortError ? 3 : 2)
      for (const projection of native.causes) expect(projection).toBe(cut)
    } finally {
      await s.kill().catch(() => {})
    }
  })

  for (const stop of ['kill', 'shutdown'] as const) {
    test(`held probes cut at a ${stop} of the default owned process leave a clean stop, every cut one identity`, async () => {
      const home = fakeClaudeHome()
      const s = new ClaudeSession({ launch: home.launch(), callbacks: { onEvent: () => {} }, terminate: { graceMs: 2000, killMs: 3000 } })
      const probes = () => home.received().filter((frame) => (frame.request as { subtype?: string } | undefined)?.subtype === 'get_context_usage').length
      try {
        await s.start()
        await (await s.send('hold-controls get_context_usage')).result
        await (await s.send('hello')).result
        await until(() => probes() === 3)
        const receipt = await s[stop]()
        expect(receipt.js).toBe('settled')
        expect(receipt.processes).toHaveLength(1)
        // Whichever cleanup won, both held probes were cut by one object and nothing failed.
        const [generation] = generationsOf(s)
        const cut = generation!.projections[0]
        expect(cut instanceof AbortError || isCleanupError(cut)).toBe(true)
        expect(generation!.projections.length).toBeGreaterThanOrEqual(2)
        for (const projection of generation!.projections) expect(projection).toBe(cut)
      } finally {
        await s.kill().catch(() => {})
      }
    })
  }

  test('held probes cut at a shutdown that ends with a trapped exit 3 stay in the native failure by one identity', async () => {
    const home = fakeClaudeHome()
    const s = new ClaudeSession({ launch: home.launch(), callbacks: { onEvent: () => {} }, terminate: { graceMs: 300, killMs: 3000 } })
    const probes = () => home.received().filter((frame) => (frame.request as { subtype?: string } | undefined)?.subtype === 'get_context_usage').length
    try {
      await s.start()
      await (await s.send('hold-controls get_context_usage')).result
      await (await s.send('trap3')).result
      await until(() => probes() === 3)
      const error = await stopFailure(s.shutdown())
      expect(error.causes).toHaveLength(1)
      const native = error.causes[0] as NativeExitFailure
      expect(native).toBeInstanceOf(NativeExitFailure)
      expect(native.facts).toMatchObject({ generation: 1, code: 3, signal: null, observedBeforeStop: false })
      const cut = native.causes[0]
      expect(cut instanceof AbortError || isCleanupError(cut)).toBe(true)
      expect(native.causes.length).toBeGreaterThanOrEqual(2)
      for (const projection of native.causes) expect(projection).toBe(cut)
    } finally {
      await s.kill().catch(() => {})
    }
  })

  test('a probe still pending after the owner already observed a clean exit fails the stop with the raw cleanup error', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      const process = pipes.processes[0]!
      await process.control('get_context_usage')
      // CONTROLLED owner evidence: the leader exited 0 before the stop; the SDK has not seen it, so its cleanup is still queued.
      const [generation] = generationsOf(s)
      const owner = controlledOwner(1, { before: { kind: 'exited', code: 0, signal: null } })
      generation!.owned = owner
      expect(cleanupOf(pipes.queries[0]!).cleanupPerformed).toBe(false)
      const error = await stopFailure(s.kill())
      expect(generation!.cleanupAtStop).toBe(false)
      expect(generation!.exitedAtStop).toBe(true)
      // K1 never signals an owner whose exit was already observed; the clean verdict adds nothing.
      expect(owner.signals).toEqual([])
      expect(error.causes).toHaveLength(1)
      expect(isCleanupError(error.causes[0])).toBe(true)
      expect((error.causes[0] as Error).stack).toContain('performCleanup')
      expect(generation!.projections).toEqual([])
    } finally {
      for (const [i, process] of pipes.processes.entries()) await release(process, pipes.queries[i]!)
    }
  })

  test('an accepted SDK cleanup error stays by identity inside the failure of a controlled failed native exit', async () => {
    const pipes = await genuinePipeQueries()
    const s = pipeSession(pipes.factory)
    try {
      await s.start()
      await pipes.processes[0]!.control('get_context_usage')
      // CONTROLLED owner evidence: alive at the sample; the termination ends with a trapped 143 after the mark (failed).
      const [generation] = generationsOf(s)
      const owner = controlledOwner(1, { atStop: { kind: 'exited', code: 143, signal: null } })
      generation!.owned = owner
      const error = await stopFailure(s.kill())
      expect(generation!.exitedAtStop).toBe(false)
      expect(owner.signals).toEqual(['SIGKILL'])
      expect(generation!.projections).toHaveLength(1)
      const cut = generation!.projections[0] as Error
      expect(isCleanupError(cut)).toBe(true)
      expect(cut.stack).toContain('performCleanup')
      expect(error.causes).toHaveLength(1)
      const native = error.causes[0] as NativeExitFailure
      expect(native).toBeInstanceOf(NativeExitFailure)
      expect(native.facts).toEqual({ generation: 1, pid: owner.pid, code: 143, signal: null, observedBeforeStop: false })
      expect(native.causes).toHaveLength(1)
      expect(native.causes[0]).toBe(cut)
    } finally {
      for (const [i, process] of pipes.processes.entries()) await release(process, pipes.queries[i]!)
    }
  })
})
