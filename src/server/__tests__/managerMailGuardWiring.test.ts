// The wiring under test: ChatSessionManager.handleDriverEvent runs the
// turn-end settle through the driverMailGuard, so a failing settle neither
// escapes the driver's emit (which killed the server in the #269 CI crash —
// the crashing settle ran from markDead's error event, inside
// runQueryLoop's catch block) nor strands the claimed message: the guard
// retries on its unref'd timer and the settle lands, scoped to the claims
// that existed at the failed attempt (review B1). The lock contention that
// makes a settle fail is covered at the store and guard levels
// (mailboxStoreBusy, driverMailGuard); here the teamMail facade's scoped
// settle is replaced by a checked double that fails once, so the
// composition is deterministic — real manager, real driver, real store,
// real guard.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import type { ClaimRef } from '../team/sessionMailbox'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'

interface FakeHandle {
  query: Query
  push: (message: SDKMessage) => void
}

/** Minimal scriptable Query: tests push SDK messages, the driver drains them. */
function fakeQueryFactory(handles: FakeHandle[]): ChatQueryFactory {
  return ({ prompt: _prompt, options: _options }) => {
    const queue: SDKMessage[] = []
    let resolveMessage: ((result: IteratorResult<SDKMessage>) => void) | null = null
    let ended = false
    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => {
          if (queue.length > 0) resolve({ value: queue.shift()!, done: false })
          else if (ended) resolve({ value: undefined, done: true })
          else resolveMessage = resolve
        })
        if (next.done) return
        yield next.value
      }
    }
    const query = Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => {
        ended = true
        resolveMessage?.({ value: undefined, done: true })
      },
    }) as unknown as Query
    const handle: FakeHandle = {
      query,
      push: (message) => {
        if (resolveMessage) {
          const resolve = resolveMessage
          resolveMessage = null
          resolve({ value: message, done: false })
        } else {
          queue.push(message)
        }
      },
    }
    handles.push(handle)
    return query
  }
}

/** A successful result ending the turn (the shape that reached settleRecipient in #269). */
function resultWithWindow(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    result: 'done',
    duration_ms: 100,
    duration_api_ms: 50,
    usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [],
    stop_reason: null,
  } as unknown as SDKMessage
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5))

describe('ChatSessionManager turn-end settle wiring', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-mail-guard-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    // A real ~/.kawai must not leak into launch resolution.
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  async function startManager(handles: FakeHandle[], events: ChatEvent[]): Promise<ChatSessionManager> {
    const manager = new ChatSessionManager({
      isDirectory: () => true,
      registry: new SessionRegistry(),
      db,
      onEvent: (_sessionId, event) => events.push(event),
      queryFactory: fakeQueryFactory(handles),
      providerUsageFetch: (async () => {
        throw new Error('provider usage pull not expected')
      }) as unknown as typeof fetch,
    })
    await manager.whenRestored()
    return manager
  }

  /** The claimed, pushed message a turn end settles (#269's crash row). */
  function claimPushed(manager: ChatSessionManager, sessionId: string, body: string): string {
    const mail = manager.mailbox.store.enqueue({
      teamId: 't', toKind: 'session', toId: sessionId, fromSession: sessionId,
      fromGroup: null, originPath: '/tmp/proj', body,
    })
    expect(manager.mailbox.store.claim(mail.id, sessionId)).toBe(true)
    expect(manager.mailbox.store.markPushed(mail.id)).toBe(true)
    return mail.id
  }

  test('a failing settle neither escapes nor strands; the retry settles', async () => {
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = await startManager(handles, events)
    try {
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await manager.send(id, 'turn')
      await flush()

      const mail = claimPushed(manager, id, 'work')
      // `mail` is the row id (claimPushed returns it), as everywhere below.

      // The double the handleDriverEvent wiring must reach: it checks the
      // session it is called with, fails the first (inline) attempt, and
      // lets the real settle run on the retry.
      const facade = (manager as unknown as {
        teamMail: { settleClaims: (sessionId: string, refs: ClaimRef[]) => void }
      }).teamMail
      const realSettleClaims = facade.settleClaims.bind(facade)
      const attempts: string[] = []
      facade.settleClaims = (sessionId: string, refs: ClaimRef[]) => {
        attempts.push(sessionId)
        if (attempts.length === 1) throw new Error('database is locked')
        realSettleClaims(sessionId, refs)
      }

      handles[0]!.push(resultWithWindow())
      // The inline attempt failed inside handleDriverEvent, which continued;
      // the guard's timer retry runs about a second later.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && manager.mailbox.store.get(mail)?.state === 'claimed') {
        await flush()
      }

      // The settle ran twice (inline + retry) for exactly this session, and
      // the retry landed: the transcript carries no receipt id, so the
      // message is hold-uncertain — settled, not stranded, not claimed.
      expect(attempts).toEqual([id, id])
      expect(manager.mailbox.store.get(mail)?.state).toBe('uncertain')
      expect(manager.mailbox.store.eventsFor(mail).some(event => event.kind === 'held-uncertain')).toBe(true)

      // The turn end was still published while the settlement failed, and
      // the driver is alive: an unguarded settle escapes handleDriverEvent,
      // kills the driver (markDead emits an error event), and the mail only
      // settles through that death — this asserts the guard's path instead.
      expect(events.some(event => event.type === 'turn_completed')).toBe(true)
      expect(events.some(event => event.type === 'error')).toBe(false)
    } finally {
      manager.shutdown()
    }
  })

  test('a retry settles only the claims that existed at the failed attempt', async () => {
    // Review B1's probe: inside the retry window the session is already
    // 'waiting', so the dispatcher can claim and push M2; a session-wide
    // retry (4e98dd64) settles it mid-turn — held uncertain while its own
    // transcript row has not landed. The scoped settle touches only the
    // snapshot taken at the failed attempt.
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = await startManager(handles, events)
    try {
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await manager.send(id, 'turn')
      await flush()

      const first = claimPushed(manager, id, 'first')

      // Whichever settle the wiring reaches fails its first (inline) call,
      // so the guard arms its retry under both the scoped and the old
      // session-wide shape.
      const facade = (manager as unknown as {
        teamMail: {
          settleRecipient: (sessionId: string) => void
          settleClaims: (sessionId: string, refs: ClaimRef[]) => void
        }
      }).teamMail
      const realSettleRecipient = facade.settleRecipient.bind(facade)
      const realSettleClaims = facade.settleClaims.bind(facade)
      let attempts = 0
      let recipientCalls = 0
      const failOnce = () => {
        attempts += 1
        if (attempts === 1) throw new Error('database is locked')
      }
      facade.settleRecipient = (sessionId: string) => {
        recipientCalls += 1
        failOnce()
        realSettleRecipient(sessionId)
      }
      facade.settleClaims = (sessionId: string, refs: ClaimRef[]) => {
        failOnce()
        realSettleClaims(sessionId, refs)
      }

      handles[0]!.push(resultWithWindow())
      // Wait out the inline attempt: only then does M2 land inside the
      // retry window.
      const inlined = Date.now() + 5000
      while (Date.now() < inlined && attempts < 1) await flush()
      expect(attempts).toBe(1)

      const second = claimPushed(manager, id, 'second')

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && attempts < 2) await flush()

      // The retry ran through the scoped settle (never the session-wide
      // one), settled the snapshot's claim, and left M2 untouched: still
      // claimed, never held uncertain — its own turn end settles it.
      expect(attempts).toBe(2)
      expect(recipientCalls).toBe(0)
      expect(manager.mailbox.store.get(first)?.state).toBe('uncertain')
      expect(manager.mailbox.store.get(second)?.state).toBe('claimed')
      expect(manager.mailbox.store.eventsFor(second).some(event => event.kind === 'held-uncertain')).toBe(false)
      expect(events.some(event => event.type === 'error')).toBe(false)
    } finally {
      manager.shutdown()
    }
  })

  test('a retry does not settle a message re-claimed after the failed attempt', async () => {
    // N1: the retry re-checks each snapshot claim's identity (same message,
    // same claimant, same claimed_at). A message the failed attempt had
    // claimed can be requeued and claimed again inside the retry window —
    // same id, same claimant, a newer claimed_at — and the newer claim
    // belongs to a newer turn: the stale ref must skip it.
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = await startManager(handles, events)
    try {
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await manager.send(id, 'turn')
      await flush()

      const mail = claimPushed(manager, id, 'work')
      const facade = (manager as unknown as {
        teamMail: { settleClaims: (sessionId: string, refs: ClaimRef[]) => void }
      }).teamMail
      const realSettleClaims = facade.settleClaims.bind(facade)
      let attempts = 0
      facade.settleClaims = (sessionId: string, refs: ClaimRef[]) => {
        attempts += 1
        if (attempts === 1) throw new Error('database is locked')
        realSettleClaims(sessionId, refs)
      }

      handles[0]!.push(resultWithWindow())
      // Wait out the inline attempt, then requeue the claimed message and
      // claim it again with an explicitly newer claimed_at, inside the
      // retry window.
      const inlined = Date.now() + 5000
      while (Date.now() < inlined && attempts < 1) await flush()
      expect(attempts).toBe(1)

      expect(manager.mailbox.store.requeue(mail)).toBe(true)
      const reclaimedAt = new Date(Date.now() + 60_000).toISOString()
      expect(manager.mailbox.store.claim(mail, id, reclaimedAt)).toBe(true)

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && attempts < 2) await flush()

      // The retry ran against the stale ref and skipped the newer claim:
      // it stands untouched, never settled behind the failed attempt.
      expect(attempts).toBe(2)
      expect(manager.mailbox.store.get(mail)?.state).toBe('claimed')
      expect(manager.mailbox.store.get(mail)?.claimedBy).toBe(id)
      expect(manager.mailbox.store.get(mail)?.claimedAt).toBe(reclaimedAt)
      expect(manager.mailbox.store.eventsFor(mail).some(event => event.kind === 'held-uncertain')).toBe(false)
      expect(events.some(event => event.type === 'error')).toBe(false)
    } finally {
      manager.shutdown()
    }
  })

  test('a second failing turn end joins the pending chain and its claims settle too', async () => {
    // N2: the second attempt's settle joins the live chain instead of being
    // dropped — on the dropping code its claims (M2) strand as 'claimed'
    // with no armed retry of their own.
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = await startManager(handles, events)
    try {
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await manager.send(id, 'turn')
      await flush()

      const first = claimPushed(manager, id, 'first')
      const facade = (manager as unknown as {
        teamMail: { settleClaims: (sessionId: string, refs: ClaimRef[]) => void }
      }).teamMail
      const realSettleClaims = facade.settleClaims.bind(facade)
      const attempts: string[] = []
      facade.settleClaims = (sessionId: string, refs: ClaimRef[]) => {
        attempts.push(sessionId)
        if (attempts.length <= 2) throw new Error('database is locked')
        realSettleClaims(sessionId, refs)
      }

      handles[0]!.push(resultWithWindow()) // turn 1 ends: inline fail, chain armed
      // Wait out the inline attempt — the fake query delivers pushed
      // messages on a later macrotask, so turn two may only open once turn
      // one's result was actually processed.
      const inlined = Date.now() + 4500
      while (Date.now() < inlined && attempts.length < 1) await flush()
      expect(attempts.length).toBe(1)
      // Still inside the retry window: a second turn ends and its settle
      // fails too — it must join the pending chain, not be dropped.
      await manager.send(id, 'turn two')
      await flush()
      const second = claimPushed(manager, id, 'second')
      handles[0]!.push(resultWithWindow())
      const deadline = Date.now() + 4500
      while (Date.now() < deadline && attempts.length < 4) await flush()

      // Two inline failures plus one retry round running both joined
      // settles. The second attempt's snapshot also holds the first message
      // (still claimed when it was taken); the first settle claims it
      // first, so the identity check skips it for the second — no double
      // settle.
      expect(attempts).toEqual([id, id, id, id])
      expect(manager.mailbox.store.get(first)?.state).toBe('uncertain')
      expect(manager.mailbox.store.get(second)?.state).toBe('uncertain')
      expect(events.some(event => event.type === 'error')).toBe(false)
    } finally {
      manager.shutdown()
    }
  })
})
