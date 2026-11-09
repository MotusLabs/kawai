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
import { exitProcess, idle, persistence, rejection, stopError, tick } from './helpers/checkpointHarness.js'
import type { Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const types = (f: Driver) => f.events.map((e) => e.type)
const errors = (f: Driver) => f.events.flatMap((e) => (e.type === 'error' ? [e.error.category] : []))
const RESUME_FAILED = { category: 'resume', message: 'the runtime did not resume the supplied conversation' }

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
    expect(types(f).slice(before)).toEqual(types(f).slice(before).filter((t) => t === 'state_changed'))
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
})
