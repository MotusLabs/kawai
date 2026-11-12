// GAP9 (task-98101592 A3, design §2's eighth exception): the opt-in
// joinAgentStartedTurns on the production ClaudeSession over a controlled
// query, and its validation through the factory. True: a queued send while
// an agent-started turn is the only open turn joins it. beforeSubmit gets
// that turn's id with the send's own new UUID, the handle names the turn and
// shares its one result, and no second turn, completion or queued entry
// appears, whether the result names the prompt or none. Omitted or false,
// and a user-started active turn, keep the queue. An interrupt or stop from
// the submission callbacks enqueues nothing. A non-boolean refuses
// construction.
import { afterEach, describe, expect, test } from 'bun:test'
import type { TurnHandle, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { BeforeSubmit } from '../src/options.js'
import { createClaudeDriverWith } from '../src/claude/driver.js'
import { CompatibilityCleanup } from './helpers/claudeCompatibilityCleanup.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { controlledQueries, frames } from './helpers/controlledQuery.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every driver this file started; the shared owner stops and joins all of them, then rethrows unasserted failures. */
const cleanup = new CompatibilityCleanup()
afterEach(() => cleanup.finishAll())

async function idle(join: boolean | undefined, hooks: DriverHooks = {}): Promise<Driver> {
  const f = driver({ ...hooks, session: { ...hooks.session, ...(join === undefined ? {} : { joinAgentStartedTurns: join }) } as never })
  cleanup.track(f)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

/** The CLI opens a turn on its own; returns that turn's id. */
async function agentTurn(f: Driver): Promise<string> {
  f.q().push(frames.taskNotification('btask_1'), frames.init())
  while (!f.events.some((e) => e.type === 'turn_started')) await tick()
  return (f.events.find((e) => e.type === 'turn_started') as { turnId: string }).turnId
}

const count = (f: Driver, type: string) => f.events.filter((e) => e.type === type).length

describe('Claude joinAgentStartedTurns (GAP9)', () => {
  /** One joined send; the turn's result names the prompt or none. */
  async function joined(named: boolean): Promise<void> {
    {
      const submitted: Array<{ messageUuid: string; turnId: string }> = []
      const beforeSubmit: BeforeSubmit = (s) => (submitted.push({ messageUuid: s.messageUuid, turnId: s.turnId }), { accepted: true })
      const f = await idle(true, { beforeSubmit })
      const agent = await agentTurn(f)
      const handle: TurnHandle = await f.d.send('while you are at it', { continuation: 'queue' })
      expect(handle.turnId).toBe(agent)
      expect(submitted).toEqual([{ messageUuid: handle.messageUuid, turnId: agent }])
      while (f.q().prompts.length === 0) await tick()
      expect(String(f.q().prompts.at(-1)!.uuid)).toBe(handle.messageUuid)
      expect(f.events.filter((e) => e.type === 'user_message').map((e) => [e.turnId, (e as { messageUuid: string }).messageUuid])).toEqual([[agent, handle.messageUuid]])
      f.q().push(frames.text('joined answer'), frames.result(named ? [handle.messageUuid] : [], 'joined answer'))
      const result: TurnResult = await handle.result
      await tick(10)
      expect([result.turnId, result.outcome, result.finalText, result.messageUuid]).toEqual([agent, 'success', 'joined answer', null])
      expect(f.results).toEqual([result])
      expect([count(f, 'turn_started'), count(f, 'turn_completed')]).toEqual([1, 1])
      expect(f.d.state).toBe('idle')
    }
  }

  // @covers: agent-runtime › Agent-started turns are reported › Opt-in queued send joins the agent-started turn
  test('a joined send names the agent-started turn and shares its one result named by the prompt', () => joined(true))

  // @covers: agent-runtime › Agent-started turns are reported › Opt-in queued send joins the agent-started turn
  test('a joined send names the agent-started turn and shares its one UUID-less result', () => joined(false))

  // @covers: agent-runtime › Agent-started turns are reported › Join defaults and stale owners
  test('omitted, false, and a user-started active turn keep the queue: the send is its own queued turn', async () => {
    const outcomes: unknown[] = []
    for (const join of [undefined, false]) {
      const f = await idle(join)
      const agent = await agentTurn(f)
      const handle = await f.d.send('queued', { continuation: 'queue' })
      outcomes.push([handle.turnId === agent, f.events.filter((e) => e.type === 'user_message').length])
    }
    const f = await idle(true)
    const first = await f.d.send('mine')
    while (f.q().prompts.length < 1) await tick()
    f.q().push(frames.init())
    const second = await f.d.send('queued', { continuation: 'queue' })
    outcomes.push([second.turnId === first.turnId, f.events.filter((e) => e.type === 'user_message').length])
    expect(outcomes).toEqual([[false, 0], [false, 0], [false, 1]])
  })

  test('an interrupt or stop from the submission callbacks enqueues nothing and opens no second turn', async () => {
    for (const how of ['interrupt', 'stop'] as const) {
      const box: { f?: Driver } = {}
      const beforeSubmit: BeforeSubmit = () => {
        if (how === 'interrupt') void box.f!.d.interrupt()
        // The reserved stop: the after-hook joins this same promise and reports its outcome.
        else void cleanup.stop(box.f!)
        return { accepted: true }
      }
      const f = (box.f = await idle(true, { beforeSubmit }))
      await agentTurn(f)
      const before = f.q().prompts.length
      let refused: unknown = null
      try {
        await f.d.send('late', { continuation: 'queue' })
      } catch (error) {
        refused = error
      }
      await tick(10)
      expect([how, refused instanceof AgentRuntimeError, f.q().prompts.length - before, count(f, 'turn_started'), count(f, 'user_message')]).toEqual([how, true, 0, 1, 0])
    }
  })

  test('a non-boolean joinAgentStartedTurns refuses construction', () => {
    const { factory } = controlledQueries()
    const base = { launch: fakeClaudeHome().launch(), callbacks: { onEvent: () => {} }, logger: { debug() {}, info() {}, warn() {}, error() {} }, permissions: { mode: 'default', enabledTools: 'all', disallowedTools: [] } }
    const refusals = (['yes', 1, null, {}] as unknown[]).map((value) => {
      try {
        createClaudeDriverWith({ ...base, joinAgentStartedTurns: value } as never, { queryFactory: factory })
        return 'accepted'
      } catch (error) {
        return error instanceof AgentRuntimeError ? error.category : 'other'
      }
    })
    expect(refusals).toEqual(['configuration', 'configuration', 'configuration', 'configuration'])
    for (const value of [true, false, undefined]) expect(() => createClaudeDriverWith({ ...base, ...(value === undefined ? {} : { joinAgentStartedTurns: value }) } as never, { queryFactory: factory })).not.toThrow()
  })
})
