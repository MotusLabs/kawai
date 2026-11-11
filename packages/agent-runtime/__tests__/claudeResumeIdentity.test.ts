// @reads: packages/agent-runtime/__tests__/fixtures/**
// G1, the resumed generation's first identity (task 4.4 Claude unit; R10,
// I2). The production ClaudeSession runs on a controlled query, so the test
// plays a runtime that answers a resume with the wrong conversation or none:
// a nonconforming runtime. The pinned CLI refuses a missing target before
// initialize instead (claudeResume.test.ts); this guard is the defense for a
// runtime that does not. A resumed generation's first init must name its
// target before anything adopts it: no checkpoint, model, binding or turn
// effect. Once it has, a later identity change is the runtime's (accepted
// succession).
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentErrorInfo } from '../src/errors.js'
import { exitProcess, idle, persistence, rejection, stopError, tick } from './helpers/checkpointHarness.js'
import type { AgentEvent } from '../src/events.js'
import type { Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const types = (f: Driver) => f.events.map((e) => e.type)
const errors = (f: Driver) => f.events.flatMap((e) => (e.type === 'error' ? [e.error.category] : []))
const RESUME_FAILED: AgentErrorInfo = { category: 'resume', message: 'the runtime did not resume the supplied conversation' }

async function stopped(f: Driver): Promise<void> {
  while (f.d.state !== 'stopped' && f.d.state !== 'stopping') await tick()
}

describe('Claude resume identity (G1)', () => {
  // @covers: agent-runtime › Shutdown preserves resumability › Missing or invalid resume identity
  test('a resumed generation whose first init names another conversation fails its turns with resume, adopts nothing, refuses later sends and disposes', async () => {
    const p = persistence()
    const f = await idle({ onCheckpoint: p.onCheckpoint })
    const t0 = await f.d.send('first')
    const queued = await f.d.send('second', { continuation: 'queue' })
    // The substituting runtime answers the turn in its own conversation.
    f.q().push(frames.init('sess-fresh', 'model-other'), frames.result([t0.messageUuid], 'fresh answer'))
    const r0 = await t0.result
    expect([r0.outcome, r0.error]).toEqual(['failed', RESUME_FAILED])
    const r1 = await queued.result
    expect([r1.outcome, r1.error]).toEqual(['failed', RESUME_FAILED])
    // Nothing of the substituted conversation was adopted or persisted.
    expect(p.calls).toEqual([])
    expect(f.results).toHaveLength(2)
    // Its later frames belong to no turn: no further result or content.
    const before = types(f).length
    f.q().push(frames.text('fresh text'), frames.result([t0.messageUuid], 'fresh done'), frames.init('sess-fresh'))
    await f.q().drain()
    expect(f.results).toHaveLength(2)
    expect(types(f).slice(before)).toEqual([])
    expect(errors(f)).toEqual(['resume'])
    // Sticky: a later send is refused with the resume failure.
    expect(await rejection(f.d.send('third'))).toMatchObject(RESUME_FAILED)
    // The driver disposes itself; the stop the caller joins reports the failure it owns.
    await stopped(f)
    const stop = await stopError(f.d.kill())
    expect(stop?.category).toBe('stop')
    expect(stop?.causes.map((c) => (c as { category?: string }).category)).toEqual(['resume'])
    // A failed stop never publishes `stopped` (accepted lifecycle semantics); it stays terminal.
    expect(f.d.state).toBe('stopping')
    expect(await rejection(f.d.start())).toMatchObject({ category: 'stopped' })
    expect(f.queries).toHaveLength(1)
  })

  test('a resumed generation whose first init carries no identity is refused the same way', async () => {
    const f = await idle({})
    const t0 = await f.d.send('first')
    const init = frames.init() as SDKMessage & { session_id?: string }
    delete init.session_id
    f.q().push(init, frames.result([t0.messageUuid], 'anonymous answer'))
    expect((await t0.result).error).toEqual(RESUME_FAILED)
    await stopped(f)
    expect((await stopError(f.d.kill()))?.causes.map((c) => (c as { category?: string }).category)).toEqual(['resume'])
  })

  test('after the first init named the target, a later identity is accepted succession: persisted, then gated work proceeds', async () => {
    const p = persistence()
    const f = await idle({ onCheckpoint: p.onCheckpoint })
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-saved'), frames.result([t0.messageUuid], 'zero'))
    expect((await t0.result).outcome).toBe('success')
    const t1 = await f.d.send('second')
    f.q().push(frames.init('sess-next'), frames.result([t1.messageUuid], 'one'))
    expect((await t1.result).outcome).toBe('success')
    expect(p.calls.map((c) => c.checkpoint.runtimeSessionId)).toEqual(['sess-next'])
    p.calls[0]!.resolve()
    const t2 = await f.d.send('third')
    expect(t2.turnId).toBeString()
    expect(errors(f)).toEqual([])
    await f.d.kill()
  })

  test('a respawn resumes the current identity and checks its first init against it; a substitution there is refused', async () => {
    const p = persistence()
    const f = await idle({ onCheckpoint: p.onCheckpoint })
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-saved'), frames.result([t0.messageUuid], 'zero'))
    await t0.result
    const t1 = await f.d.send('second')
    f.q().push(frames.init('sess-next'), frames.result([t1.messageUuid], 'one'))
    await t1.result
    p.calls[0]!.resolve()
    await exitProcess(f)
    const restart = f.d.start()
    while (f.queries.length < 2) await tick()
    // The respawn resumes the identity the runtime reported last, not the original target.
    expect(f.q().options.resume).toBe('sess-next')
    f.q().ready()
    await restart
    const t2 = await f.d.send('third')
    f.q().push(frames.init('sess-saved'), frames.result([t2.messageUuid], 'old answer'))
    expect((await t2.result).error).toEqual(RESUME_FAILED)
    expect(p.calls).toHaveLength(1)
    await stopped(f)
    expect((await stopError(f.d.kill()))?.category).toBe('stop')
  })

  test('a fresh launch has no target: its first identity is the new conversation and is persisted', async () => {
    const p = persistence()
    const f = await idle({ resume: null, onCheckpoint: p.onCheckpoint })
    expect(f.q().options.resume).toBeUndefined()
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-new'), frames.result([t0.messageUuid], 'zero'))
    expect((await t0.result).outcome).toBe('success')
    expect(p.calls.map((c) => c.checkpoint.runtimeSessionId)).toEqual(['sess-new'])
    p.calls[0]!.resolve()
    await f.d.kill()
  })

  // F1 (findings-6e7c50c8): the refusal's results are decided before any callback runs, so a stop or
  // interrupt reentered from a callback cannot overwrite them, and a queued turn that never opened gets
  // no completion event.
  const TRIGGERS = ['request_resolved', 'error', 'turn_completed', 'onTurnResult'] as const
  const ACTIONS = ['interrupt', 'shutdown', 'kill'] as const
  for (const trigger of TRIGGERS) {
    for (const action of ACTIONS) {
      test(`F1: ${action}() reentered from ${trigger} during the refusal leaves both turns failed with resume, each settled once`, async () => {
        let f!: Driver
        let reentered: Promise<unknown> | null = null
        const reenter = () => {
          if (reentered === null) reentered = (f.d[action]() as Promise<unknown>).catch((e: unknown) => e)
        }
        const onEvent = (e: AgentEvent) => {
          if (e.type === trigger || (trigger === 'error' && e.type === 'error' && e.error.category === 'resume')) reenter()
        }
        // 'wait': the request stays pending until the refusal cancels it (the default denies it at once).
        f = await idle({ unansweredRequests: 'wait', ...(trigger === 'onTurnResult' ? { onTurnResult: reenter } : { onEvent }) })
        const t0 = await f.d.send('first')
        const queued = await f.d.send('second', { continuation: 'queue' })
        // A pending request, so the refusal's request cancellation publishes a callback too.
        const canUseTool = f.q().options.canUseTool!
        const asked = canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [], toolUseID: 'toolu_1' } as never)
        await tick()
        expect([f.d.pendingRequests().length, reentered]).toEqual([1, null])
        f.q().push(frames.init('sess-fresh'), frames.result([t0.messageUuid], 'fresh answer'))
        const results = await Promise.all([t0.result, queued.result])
        expect(results.map((r) => [r.outcome, r.error])).toEqual([['failed', RESUME_FAILED], ['failed', RESUME_FAILED]])
        expect(reentered).not.toBeNull()
        await reentered
        await asked
        // onTurnResult ran once per handle, with the decided result.
        expect(f.results.map((r) => [r.turnId, r.outcome, r.error?.category])).toEqual([[t0.turnId, 'failed', 'resume'], [queued.turnId, 'failed', 'resume']])
        const ids = (type: string) => f.events.flatMap((e) => (e.type === type ? [(e as { turnId: string }).turnId] : []))
        expect([ids('turn_started'), ids('turn_completed'), ids('turn_interrupted')]).toEqual([[t0.turnId], [t0.turnId], []])
        expect(errors(f)).toEqual(['resume'])
        expect(await rejection(f.d.send('third'))).toMatchObject(RESUME_FAILED)
        const stop = await stopError(f.d.kill())
        expect(stop?.category).toBe('stop')
        expect(stop?.causes.some((c) => (c as { category?: string }).category === 'resume')).toBe(true)
      })
    }
  }

  test('F1: a queued turn that never opened resolves with the resume failure and publishes no turn event', async () => {
    const f = await idle({})
    const t0 = await f.d.send('first')
    const queued = await f.d.send('queued', { continuation: 'queue' })
    f.q().push(frames.init('sess-fresh'))
    const results = await Promise.all([t0.result, queued.result])
    expect(results.map((r) => [r.turnId, r.outcome, r.error])).toEqual([[t0.turnId, 'failed', RESUME_FAILED], [queued.turnId, 'failed', RESUME_FAILED]])
    await stopError(f.d.kill())
    const ids = (type: string) => f.events.flatMap((e) => (e.type === type ? [(e as { turnId: string }).turnId] : []))
    expect(ids('turn_started')).toEqual([t0.turnId])
    expect(ids('turn_completed')).toEqual([t0.turnId])
    expect(ids('turn_interrupted')).toEqual([])
    expect(f.events.filter((e) => 'turnId' in e && (e as { turnId: string }).turnId === queued.turnId)).toEqual([])
  })
})
