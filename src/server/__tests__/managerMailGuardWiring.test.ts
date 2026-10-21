// The wiring under test: ChatSessionManager.handleDriverEvent runs the
// turn-end settle through the driverMailGuard, so a failing settle neither
// escapes the driver's emit (which killed the server in the #269 CI crash —
// the crashing settle ran from markDead's error event, inside
// runQueryLoop's catch block) nor strands the claimed message: the guard
// retries on its unref'd timer and the settle lands. The lock contention
// that makes a settle fail is covered at the store and guard levels
// (mailboxStoreBusy, driverMailGuard); here the teamMail facade's settle is
// replaced by a checked double that fails once, so the composition is
// deterministic — real manager, real driver, real store, real guard.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
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

  test('a failing settle neither escapes nor strands; the retry settles', async () => {
    const registry = new SessionRegistry()
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = new ChatSessionManager({
      isDirectory: () => true,
      registry,
      db,
      onEvent: (_sessionId, event) => events.push(event),
      queryFactory: fakeQueryFactory(handles),
      providerUsageFetch: (async () => {
        throw new Error('provider usage pull not expected')
      }) as unknown as typeof fetch,
    })
    await manager.whenRestored()
    try {
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await manager.send(id, 'turn')
      await flush()

      // The claimed, pushed message a turn end settles (#269's crash row).
      const mail = manager.mailbox.store.enqueue({
        teamId: 't', toKind: 'session', toId: id, fromSession: id,
        fromGroup: null, originPath: '/tmp/proj', body: 'work',
      })
      expect(manager.mailbox.store.claim(mail.id, id)).toBe(true)
      expect(manager.mailbox.store.markPushed(mail.id)).toBe(true)

      // The double the handleDriverEvent wiring must reach: it checks the
      // session it is called with, fails the first (inline) attempt, and
      // lets the real settle run on the retry.
      const facade = (manager as unknown as {
        teamMail: { settleRecipient: (sessionId: string) => void }
      }).teamMail
      const realSettle = facade.settleRecipient.bind(facade)
      const attempts: string[] = []
      facade.settleRecipient = (sessionId: string) => {
        attempts.push(sessionId)
        if (attempts.length === 1) throw new Error('database is locked')
        realSettle(sessionId)
      }

      handles[0]!.push(resultWithWindow())
      // The inline attempt failed inside handleDriverEvent, which continued;
      // the guard's timer retry runs about a second later.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && manager.mailbox.store.get(mail.id)?.state === 'claimed') {
        await flush()
      }

      // The settle ran twice (inline + retry) for exactly this session, and
      // the retry landed: the transcript carries no receipt id, so the
      // message is hold-uncertain — settled, not stranded, not claimed.
      expect(attempts).toEqual([id, id])
      expect(manager.mailbox.store.get(mail.id)?.state).toBe('uncertain')
      expect(manager.mailbox.store.eventsFor(mail.id).some(event => event.kind === 'held-uncertain')).toBe(true)

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
})
