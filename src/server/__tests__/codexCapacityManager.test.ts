// codex-capacity-retry W1-W4, W6 and W8 (design "Acceptance oracles", tasks
// 3.1 and 3.3) through Kawai's production composition: ChatSessionManager,
// its mailbox and dispatcher, the limit store and LimitOutcomes, the Codex
// adapter and the in-tree package session, with only the package's process
// spawn and capacity clock replaced (helpers/codexCapacityManager.ts). The
// test answers the app-server by hand.
import { afterEach, describe, expect, test } from 'bun:test'
import { CODEX_CAPACITY_CONTINUATION } from '@motuslabs/agent-runtime/codex'
import { until } from './codexDriverHarness'
import { capacityManager, type CapacityManager } from './helpers/codexCapacityManager'

let h: CapacityManager | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

export const W_TABLE = [
  ['W1', 'Production manager, delivered mail, capacity failure then success', 'Claim/receipt retained; no park/forward/release; one logical completion; no sibling cooldown'],
  ['W2', 'Production manager, delivered mail, capacity window exhausted', 'One ordinary failure; no quota-driven mailbox resolution or sibling cooldown'],
  ['W3', 'Production manager, retry ends on actual usage limit', 'Existing quota event, home cooldown, and mailbox resolution still occur'],
  ['W4', 'Completed tool result then capacity continuation', 'Original input/envelope sent once; no tool replay by Kawai; original policy/thread/model retained; logical usage covers all attempts'],
  ['W6', 'Independent pre-existing quota cooldown plus capacity error', 'Existing cooldown neither cleared nor extended'],
  ['W8', 'Production manager/mailbox: urgent direct mail delivered during backoff', 'Urgent envelope delivered once with its original receipt; recovery generation invalidated; no old continuation dispatched afterward; the urgent mail is never parked, forwarded, or released'],
] as const

const text = (request: { params: Record<string, any> }) => (request.params.input as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n')
const failed = (turnId: string, codexErrorInfo: unknown) => ({ turn: { id: turnId, status: 'failed', items: [], error: { message: 'over capacity', codexErrorInfo, additionalDetails: null } } })

/** Deliver one mail to the chat; resolves with its id and the turn/start that carried its envelope. */
async function deliver(s: CapacityManager, body: string, priority: 'normal' | 'urgent' = 'normal') {
  const before = s.server.turnStarts().length
  const mail = s.manager.mailbox.store.enqueue({ teamId: s.teamId, toKind: 'session', toId: s.id, fromSession: null, fromGroup: null, originPath: s.project, priority, body })
  s.manager.dispatcher.notify()
  await until(() => s.server.turnStarts().length > before)
  const request = s.server.turnStarts().at(-1)!
  expect(text(request)).toContain(body)
  // Codex's rollout writer records the envelope: the mail's receipt.
  s.writeUserRow(text(request))
  return { mail: mail.id, request }
}

async function bind(s: CapacityManager, request: { id: number }, attempt: string) {
  s.server.reply(request.id, { turn: { id: attempt, status: 'inProgress', items: [], error: null } })
  s.server.notify('turn/started', { turn: { id: attempt, status: 'inProgress', items: [], error: null } })
  await s.server.flush()
}

/** The armed capacity wakeup fires; resolves with the continuation it sent. */
async function wake(s: CapacityManager) {
  const before = s.server.turnStarts().length
  s.clock.advance(Math.min(...[...s.clock.timers.values()].map((timer) => timer.at)) - s.clock.now)
  await until(() => s.server.turnStarts().length > before)
  const request = s.server.turnStarts().at(-1)!
  expect(text(request)).toBe(CODEX_CAPACITY_CONTINUATION)
  s.writeUserRow(text(request))
  return request
}

const status = (s: CapacityManager) => s.manager.getSnapshot(s.id)?.status
const terminals = (s: CapacityManager) => s.events.filter((event) => event.type === 'turn_completed' || event.type === 'turn_interrupted')

/** Fail every continuation until the window closes (no wakeup stays armed); returns the attempts used. */
async function exhaust(s: CapacityManager, first: string): Promise<number> {
  let attempts = 1
  s.server.notify('turn/completed', failed(first, 'serverOverloaded'))
  await s.server.flush()
  for (;;) {
    await until(() => s.clock.pending === 1 || status(s) !== 'working')
    if (s.clock.pending === 0) return attempts
    const before = s.server.turnStarts().length
    s.clock.advance(Math.min(...[...s.clock.timers.values()].map((timer) => timer.at)) - s.clock.now)
    await s.server.flush()
    if (s.server.turnStarts().length === before) {
      await until(() => status(s) !== 'working')
      return attempts
    }
    const id = `a${++attempts}`
    await bind(s, s.server.turnStarts().at(-1)!, id)
    s.server.notify('turn/completed', failed(id, 'serverOverloaded'))
    await s.server.flush()
  }
}

const usageRows = (s: CapacityManager) => s.db.db.prepare('SELECT turn_id, input_tokens, output_tokens FROM chat_turn_usage WHERE session_id = ?').all(s.id) as Array<{ turn_id: string; input_tokens: number; output_tokens: number }>
const breakdown = (input: number, output: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output })
const tokens = (turnId: string, input: number, output: number) => ({ turnId, tokenUsage: { total: breakdown(input, output), last: breakdown(input, output), modelContextWindow: 200_000 } })
const HOUR_S = 3_600

describe('codex-capacity-retry through the Kawai manager', () => {
  test('the W table rows are committed verbatim', () => {
    expect(W_TABLE.map((row) => row[0])).toEqual(['W1', 'W2', 'W3', 'W4', 'W6', 'W8'])
  })

  // @covers: codex-chat-sessions › Capacity recovery preserves conversation and work › Mail recovery
  test('W1: delivered mail through a capacity failure then success keeps its claim and receipt, completes once and cools nothing', async () => {
    h = await capacityManager()
    const s = h
    expect(s.options.at(-1)).toMatchObject({ capacityRecovery: 'bounded' })
    const { mail, request } = await deliver(s, 'Fix the failing build')
    await bind(s, request, 'a1')
    s.server.notify('turn/completed', failed('a1', 'serverOverloaded'))
    await s.server.flush()
    await until(() => s.clock.pending === 1)
    const store = s.manager.mailbox.store
    expect(store.get(mail)).toMatchObject({ claimedBy: s.id, parkCount: 0, resumeMessageId: null })
    expect(store.get(mail)!.state).not.toBe('parked')
    expect(status(s)).toBe('working')
    expect(terminals(s)).toEqual([])
    await bind(s, await wake(s), 'a2')
    s.server.notify('turn/completed', { turn: { id: 'a2', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'm-a2', text: 'fixed' }] } })
    await until(() => status(s) === 'waiting' && store.get(mail)?.state === 'delivered')
    expect(terminals(s).map((event) => event.type)).toEqual(['turn_completed'])
    expect(store.get(mail)).toMatchObject({ state: 'delivered', claimedBy: s.id, parkCount: 0, resumeMessageId: null })
    expect(s.manager.limitEvents.forProvider(s.homeProvider)).toEqual([])
    for (const profile of ['codex', 'codex-fast']) {
      expect(s.manager.limitEvents.forProfile(profile)).toEqual([])
      expect(s.manager.limitEvents.cooldownFor(profile, s.homeProvider).until).toBeNull()
    }
    // The envelope went to Codex once; the continuation carried only the runtime's notice.
    expect(s.server.turnStarts().map(text).filter((input) => input.includes('Fix the failing build'))).toHaveLength(1)
  })
  test('W1: a human turn, delivered peer mail and an agent-started turn each recover from capacity once and record no limit', async () => {
    for (const kind of ['human', 'peer', 'agent'] as const) {
      h = await capacityManager()
      const s = h
      let mail: string | null = null
      if (kind === 'human') {
        expect((await s.manager.send(s.id, 'Tidy the docs')).ok).toBe(true)
        await until(() => s.server.turnStarts().length === 1)
        await bind(s, s.server.turnStarts()[0]!, 'a1')
      } else if (kind === 'peer') {
        const enqueued = s.manager.mailbox.store.enqueue({ teamId: s.teamId, toKind: 'session', toId: s.id, fromSession: 'chat-peer-lead', fromGroup: 'lead', originPath: s.project, body: 'Review the PR' })
        mail = enqueued.id
        s.manager.dispatcher.notify()
        await until(() => s.server.turnStarts().length === 1)
        s.writeUserRow(text(s.server.turnStarts()[0]!))
        await bind(s, s.server.turnStarts()[0]!, 'a1')
      } else {
        // The agent starts a turn itself (a background task finished): no turn/start, no input.
        s.server.notify('turn/started', { turn: { id: 'a1', status: 'inProgress', items: [], error: null } })
        await until(() => status(s) === 'working')
      }
      s.server.notify('turn/completed', failed('a1', 'serverOverloaded'))
      await until(() => s.clock.pending === 1)
      expect(status(s)).toBe('working')
      await bind(s, await wake(s), 'a2')
      s.server.notify('turn/completed', { turn: { id: 'a2', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'm-a2', text: 'ok' }] } })
      await until(() => status(s) === 'waiting')
      expect(terminals(s).map((event) => event.type)).toEqual(['turn_completed'])
      expect(s.manager.limitEvents.forProvider(s.homeProvider)).toEqual([])
      if (mail) await until(() => s.manager.mailbox.store.get(mail!)?.state === 'delivered')
      if (mail) expect(s.manager.mailbox.store.get(mail)).toMatchObject({ claimedBy: s.id, parkCount: 0, resumeMessageId: null })
      await s.cleanup()
      h = null
    }
  })

  // @covers: codex-chat-sessions › Codex capacity failures recover within a bounded window › Capacity persists
  test('W2: delivered mail through an exhausted capacity window ends in one ordinary failure with no quota mailbox resolution or cooldown', async () => {
    // The window closes at a wakeup (L10), or while a continuation runs and that attempt then fails at capacity (L4).
    for (const ending of ['wakeup', 'attempt'] as const) {
      h = await capacityManager()
      const s = h
      const { mail, request } = await deliver(s, 'Ship the release notes')
      await bind(s, request, 'a1')
      if (ending === 'wakeup') expect(await exhaust(s, 'a1')).toBeGreaterThan(5)
      else {
        s.server.notify('turn/completed', failed('a1', 'serverOverloaded'))
        await s.server.flush()
        await bind(s, await wake(s), 'a2')
        s.clock.advance(600_000)
        s.server.notify('turn/completed', failed('a2', 'serverOverloaded'))
      }
      await until(() => status(s) === 'waiting')
      // Every continuation started before the ten-minute deadline; the turn then ended once, failed.
      expect(s.server.turnStarts().slice(1).every((r) => r.at < 600_000)).toBe(true)
      expect(terminals(s)).toEqual([expect.objectContaining({ type: 'turn_completed', isError: true })])
      expect(s.events.filter((event) => event.type === 'error')).toHaveLength(1)
      const stored = s.manager.mailbox.store.get(mail)!
      expect(stored).toMatchObject({ claimedBy: s.id, parkCount: 0, resumeMessageId: null })
      expect(['parked', 'queued']).not.toContain(stored.state)
      expect(s.manager.limitEvents.forProvider(s.homeProvider)).toEqual([])
      for (const profile of ['codex', 'codex-fast']) expect(s.manager.limitEvents.cooldownFor(profile, s.homeProvider).until).toBeNull()
      await s.cleanup()
      h = null
    }
  })

  // @covers: profile-limit-handling › Codex model capacity does not cool a shared login › Real quota after capacity
  test('W3: a retry that ends on an actual usage limit records the quota event, cools the home and resolves the mail exactly as without capacity', async () => {
    /** One delivered mail whose turn ends on a usage limit, after `capacity` capacity attempts. */
    const run = async (capacity: number) => {
      h = await capacityManager()
      const s = h
      const { mail, request } = await deliver(s, 'Rebuild the index')
      await bind(s, request, 'a1')
      let attempt = 'a1'
      for (let n = 0; n < capacity; n++) {
        s.server.notify('turn/completed', failed(attempt, 'serverOverloaded'))
        await s.server.flush()
        attempt = `a${n + 2}`
        await bind(s, await wake(s), attempt)
      }
      const resetsAt = Math.floor(Date.now() / 1000) + HOUR_S
      s.server.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null } } })
      s.server.notify('turn/completed', failed(attempt, 'usageLimitExceeded'))
      await until(() => s.manager.mailbox.store.get(mail)?.claimedBy === null)
      const reset = new Date(resetsAt * 1000).toISOString()
      expect(s.manager.limitEvents.forProvider(s.homeProvider)).toEqual([expect.objectContaining({ kind: 'usageLimitExceeded', final: true, profileId: 'codex', resetsAt: reset })])
      for (const profile of ['codex', 'codex-fast']) expect(s.manager.limitEvents.cooldownFor(profile, s.homeProvider).until).not.toBeNull()
      expect(s.manager.limitEvents.cooldownFor('codex-2', s.otherProvider).until).toBeNull()
      const { state, claimedBy, deliverAt, parkCount, toId } = s.manager.mailbox.store.get(mail)!
      const outcome = { state, claimedBy, deliverAt: deliverAt === reset ? 'reset' : deliverAt, parkCount, toId: toId === s.id ? 'self' : toId }
      await s.cleanup()
      h = null
      return outcome
    }
    const control = await run(0)
    expect(control).toEqual({ state: 'queued', claimedBy: null, deliverAt: 'reset', parkCount: 0, toId: 'self' })
    expect(await run(2)).toEqual(control)
  })

  // @covers: codex-chat-sessions › Capacity recovery preserves conversation and work › Work before overload
  test('W4: after a completed tool the continuation keeps thread, model and policy, replays no input or tool, and usage covers both attempts', async () => {
    h = await capacityManager()
    const s = h
    const { request } = await deliver(s, 'Run the migrations')
    await bind(s, request, 'a1')
    s.server.notify('thread/tokenUsage/updated', tokens('a1', 100, 10))
    s.server.notify('item/started', { turnId: 'a1', item: { type: 'commandExecution', id: 'cmd-1', command: 'bun migrate', cwd: s.project, status: 'inProgress' } })
    s.server.notify('item/completed', { turnId: 'a1', item: { type: 'commandExecution', id: 'cmd-1', command: 'bun migrate', cwd: s.project, status: 'completed', exitCode: 0, aggregatedOutput: 'migrated' } })
    s.server.notify('turn/completed', failed('a1', 'serverOverloaded'))
    await s.server.flush()
    const sentBefore = s.server.requests.length
    const continuation = await wake(s)
    // Only the continuation was written after the failure: Kawai replays no tool and resends no input.
    expect(s.server.requests.slice(sentBefore).map((r) => r.method)).toEqual(['turn/start'])
    const { input: _a, clientUserMessageId: _b, ...originalPolicy } = request.params
    const { input: _c, clientUserMessageId: _d, ...continuationPolicy } = continuation.params
    expect(continuationPolicy).toEqual(originalPolicy)
    expect(continuation.params.threadId).toBe(request.params.threadId)
    await bind(s, continuation, 'a2')
    s.server.notify('thread/tokenUsage/updated', tokens('a2', 160, 25))
    s.server.notify('turn/completed', { turn: { id: 'a2', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'm-a2', text: 'migrated' }] } })
    await until(() => status(s) === 'waiting' && usageRows(s).length === 1)
    const completed = terminals(s)
    expect(completed.map((event) => event.type)).toEqual(['turn_completed'])
    expect(usageRows(s)).toEqual([{ turn_id: completed[0]!.turnId, input_tokens: 160, output_tokens: 25 }])
    expect(s.events.filter((event) => event.type === 'tool_result')).toHaveLength(1)
    expect(s.server.turnStarts().map(text).filter((input) => input.includes('Run the migrations'))).toHaveLength(1)
  })

  // @covers: profile-limit-handling › Codex model capacity does not cool a shared login › Independent cooldown remains
  test('W6: a pre-existing quota cooldown is neither cleared nor extended by a capacity error', async () => {
    h = await capacityManager()
    const s = h
    const resetsAt = new Date(Date.now() + 2 * HOUR_S * 1000).toISOString()
    s.manager.limitEvents.record({ profileId: 'codex', sessionId: 'chat-earlier', groupId: null, kind: 'usageLimitExceeded', final: true, status: null, message: 'limit', resetsAt, providerId: s.homeProvider, window: null })
    const before = { codex: s.manager.limitEvents.cooldownFor('codex', s.homeProvider), fast: s.manager.limitEvents.cooldownFor('codex-fast', s.homeProvider), events: s.manager.limitEvents.forProvider(s.homeProvider) }
    expect(before.codex.until).not.toBeNull()
    const { request } = await s.manager.send(s.id, 'keep going').then(async (sent) => {
      expect(sent.ok).toBe(true)
      await until(() => s.server.turnStarts().length === 1)
      return { request: s.server.turnStarts()[0]! }
    })
    await bind(s, request, 'a1')
    s.server.notify('error', { turnId: 'a1', willRetry: true, error: { message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null } })
    await exhaust(s, 'a1')
    await until(() => status(s) === 'waiting')
    expect(s.manager.limitEvents.forProvider(s.homeProvider)).toEqual(before.events)
    expect(s.manager.limitEvents.cooldownFor('codex', s.homeProvider)).toEqual(before.codex)
    expect(s.manager.limitEvents.cooldownFor('codex-fast', s.homeProvider)).toEqual(before.fast)
  })

  // @covers: codex-chat-sessions › Capacity retries are visible and cancellable › Urgent delivery during backoff
  test('W8: urgent direct mail during backoff is delivered once with its own receipt, invalidates recovery and is never parked, forwarded or released', async () => {
    h = await capacityManager()
    const s = h
    const first = await deliver(s, 'Write the changelog')
    await bind(s, first.request, 'a1')
    s.server.notify('turn/completed', failed('a1', 'serverOverloaded'))
    await until(() => s.clock.pending === 1)
    const urgent = await deliver(s, 'Stop and fix production', 'urgent')
    // The backoff had no live attempt: the dispatcher's interrupt sends no turn/interrupt, and the wakeup is gone.
    expect(s.server.interrupts()).toEqual([])
    expect(s.clock.pending).toBe(0)
    expect(s.server.turnStarts().map(text).filter((input) => input.includes('Stop and fix production'))).toHaveLength(1)
    await bind(s, urgent.request, 'u1')
    s.clock.advance(3_600_000)
    await s.server.flush()
    expect(s.server.turnStarts().map(text).filter((input) => input === CODEX_CAPACITY_CONTINUATION)).toEqual([])
    s.server.notify('turn/completed', { turn: { id: 'u1', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'm-u1', text: 'fixed' }] } })
    const store = s.manager.mailbox.store
    await until(() => store.get(urgent.mail)?.state === 'delivered')
    expect(store.get(urgent.mail)).toMatchObject({ claimedBy: s.id, parkCount: 0, resumeMessageId: null })
    expect(s.server.turnStarts().map(text).filter((input) => input === CODEX_CAPACITY_CONTINUATION)).toEqual([])
  })
})
