import { afterAll, describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import type { ServerMessage } from '../../shared/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHAT_DEBUG_PAGE_SIZE, ChatConnections } from '../chat/ChatConnections'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'

function harness(wireLogs?: ChatWireLogs) {
  const calls: unknown[] = []
  const snapshot: Extract<ServerMessage, { type: 'chat-snapshot' }> = {
    type: 'chat-snapshot', sessionId: 'chat-1', events: [],
    pendingRequests: [{ kind: 'approval', requestId: 'approval-1', tool: 'Bash', input: {}, at: 'now' }],
    status: 'permission', throughSequence: 0,
    commands: { status: 'unavailable', commands: [] },
  }
  let pending = true
  const manager = {
    has: (id: string) => id === 'chat-1',
    getSnapshot: () => snapshot,
    send: async (...args: unknown[]) => { calls.push(['send', ...args]); return { ok: true } },
    start: (...args: unknown[]) => { calls.push(['start', ...args]); return Promise.resolve({ ok: true }) },
    interrupt: (...args: unknown[]) => { calls.push(['interrupt', ...args]); return { ok: true } },
    archive: (...args: unknown[]) => { calls.push(['archive', ...args]); return { ok: true } },
    restore: (...args: unknown[]) => { calls.push(['restore', ...args]); return { ok: true } },
    resolveApproval: (...args: unknown[]) => {
      calls.push(['approval', ...args])
      if (!pending) return { ok: false, error: 'Already resolved' }
      pending = false
      connections.publish('chat-1', { id: 'resolved', sequence: 3, at: 'now', type: 'request_resolved', requestId: 'approval-1', outcome: 'allowed' })
      return { ok: true }
    },
    answerQuestion: (...args: unknown[]) => { calls.push(['answer', ...args]); return { ok: true } },
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager, wireLogs)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  return { connections, connection, messages, calls, snapshot }
}

const delta = (sequence: number, turnId = 'turn-1'): ChatEvent => ({
  type: 'assistant_delta', id: `event-${sequence}`, sequence, at: 'now', turnId, messageId: 'message-1', delta: `${sequence}`,
})

describe('chat WebSocket subscriptions', () => {
  test('routes send, interrupt, approval, and question answers', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-send', sessionId: 'chat-1', text: 'hello' })
    await h.connections.handle(h.connection, { type: 'chat-interrupt', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-answer', sessionId: 'chat-1', requestId: 'question-1', answers: {} })
    await h.connections.handle(h.connection, { type: 'chat-approval', sessionId: 'chat-1', requestId: 'approval-1', decision: 'allow' })
    expect(h.calls).toEqual([
      ['send', 'chat-1', 'hello'], ['interrupt', 'chat-1'], ['answer', 'chat-1', 'question-1', {}], ['approval', 'chat-1', 'approval-1', 'allow'],
    ])
  })

  test('snapshot precedes coalesced live events and contains pending approval', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    h.connections.publish('chat-1', delta(2))
    expect(h.messages).toEqual([h.snapshot])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages[1]).toEqual({ type: 'chat-events', sessionId: 'chat-1', events: [delta(1), delta(2)] })
  })

  test('attach sends the snapshot before starting the agent', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    // The snapshot is on the wire before the start request reaches the
    // manager; the manager dedupes concurrent attaches into one spawn.
    expect(h.messages).toEqual([h.snapshot])
    expect(h.calls).toEqual([['start', 'chat-1']])
    // A second client attaching routes another idempotent start request.
    await h.connections.handle({ send: () => {} }, { type: 'chat-attach', sessionId: 'chat-1' })
    expect(h.calls).toEqual([['start', 'chat-1'], ['start', 'chat-1']])
  })

  test('deltas from different turns remain in different batches', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    h.connections.publish('chat-1', delta(2, 'turn-2'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-events', sessionId: 'chat-1', events: [delta(1)] },
      { type: 'chat-events', sessionId: 'chat-1', events: [delta(2, 'turn-2')] },
    ])
  })

  test('detach and disconnect discard buffered output', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(1)
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(2))
    h.connections.disconnect(h.connection)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(2)
  })

  test('only the first approval succeeds and both browsers receive its resolution', async () => {
    const h = harness()
    const secondMessages: ServerMessage[] = []
    const second = { send: (message: ServerMessage) => secondMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(second, { type: 'chat-attach', sessionId: 'chat-1' })
    const answer = { type: 'chat-approval', sessionId: 'chat-1', requestId: 'approval-1', decision: 'allow' } as const
    await h.connections.handle(h.connection, answer)
    await h.connections.handle(second, answer)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.some(message => message.type === 'chat-events')).toBe(true)
    expect(secondMessages.some(message => message.type === 'chat-events')).toBe(true)
    expect(secondMessages).toContainEqual({ type: 'error', message: 'Already resolved' })
  })

  test('command-state pushes reach only subscribed connections, unbatched', async () => {
    const h = harness()
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    // No attach yet: nobody receives the state.
    h.connections.publishCommandState('chat-1', { status: 'loading', commands: [] })
    expect(h.messages).toEqual([])

    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-1' })
    const ready = {
      status: 'ready' as const,
      commands: [{ name: 'usage', description: 'costs', aliases: [], source: 'builtin' as const }],
    }
    h.connections.publishCommandState('chat-1', ready)
    const expected = { type: 'chat-commands' as const, sessionId: 'chat-1', state: ready }
    // Sent immediately: no timer flush needed.
    expect(h.messages).toEqual([h.snapshot, expected])
    expect(otherMessages).toEqual([h.snapshot, expected])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toEqual([h.snapshot, expected])
  })

  test('unknown sessions return an actionable error', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-send', sessionId: 'missing', text: 'hello' })
    expect(h.messages).toEqual([{ type: 'error', message: 'Unknown chat session missing' }])
    expect(h.calls).toEqual([])
  })

  test('archive and restore route to the manager; failures echo an error', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-archive', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-restore', sessionId: 'chat-1' })
    expect(h.calls).toEqual([['archive', 'chat-1'], ['restore', 'chat-1']])
    expect(h.messages).toEqual([])

    await h.connections.handle(h.connection, { type: 'chat-archive', sessionId: 'missing' })
    await h.connections.handle(h.connection, { type: 'chat-restore', sessionId: 'missing' })
    expect(h.messages).toEqual([
      { type: 'error', message: 'Unknown chat session missing' },
      { type: 'error', message: 'Unknown chat session missing' },
    ])
  })
})

describe('chat debug subscriptions', () => {
  const dirs: string[] = []
  function wireLogs(): ChatWireLogs {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-debug-ws-'))
    dirs.push(dir)
    return new ChatWireLogs({ dir })
  }
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const debugMessages = (messages: ServerMessage[]) =>
    messages.filter((message): message is Extract<ServerMessage, { type: 'chat-debug-frames' }> => message.type === 'chat-debug-frames')
  const seqsOf = (message: Extract<ServerMessage, { type: 'chat-debug-frames' }>) => message.frames.map(frame => frame.seq)

  test('open replies with the newest page and hasOlder; page walks back; close stops live frames', async () => {
    const logs = wireLogs()
    const log = logs.get('chat-1')
    for (let index = 0; index < CHAT_DEBUG_PAGE_SIZE + 5; index += 1) log.record('in', `frame-${index}`)
    const h = harness(logs)
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    const [first] = debugMessages(h.messages)
    expect(first).toMatchObject({ sessionId: 'chat-1', page: true, hasOlder: true })
    expect(first!.frames).toHaveLength(CHAT_DEBUG_PAGE_SIZE)
    expect(first!.frames.at(-1)!.seq).toBe(CHAT_DEBUG_PAGE_SIZE + 5)

    await h.connections.handle(h.connection, { type: 'chat-debug-page', sessionId: 'chat-1', beforeSeq: first!.frames[0]!.seq })
    const older = debugMessages(h.messages)[1]!
    expect(older).toMatchObject({ page: true, hasOlder: false })
    expect(seqsOf(older)).toEqual([1, 2, 3, 4, 5])

    log.record('out', 'live')
    await tick()
    expect(seqsOf(debugMessages(h.messages)[2]!)).toEqual([CHAT_DEBUG_PAGE_SIZE + 6])
    expect(debugMessages(h.messages)[2]!.page).toBeUndefined()

    await h.connections.handle(h.connection, { type: 'chat-debug-close', sessionId: 'chat-1' })
    log.record('out', 'after close')
    await tick()
    expect(debugMessages(h.messages)).toHaveLength(3)
  })

  test('only debug-open connections receive frames; chat attach alone receives none', async () => {
    const logs = wireLogs()
    const h = harness(logs)
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    logs.get('chat-1').record('in', 'one')
    logs.get('chat-1').record('in', 'two')
    await tick()
    expect(debugMessages(otherMessages)).toEqual([])
    const live = debugMessages(h.messages).filter(message => !message.page)
    expect(live.flatMap(seqsOf)).toEqual([1, 2])
  })

  test('frames recorded while the open page is being read are still delivered', async () => {
    const logs = wireLogs()
    logs.get('chat-1').record('in', 'before')
    const h = harness(logs)
    const opening = h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    logs.get('chat-1').record('in', 'during')
    await opening
    await tick()
    const delivered = new Set(debugMessages(h.messages).flatMap(seqsOf))
    expect([...delivered].sort()).toEqual([1, 2])
  })

  test('large live bursts are split into bounded batches in order', async () => {
    const logs = wireLogs()
    const h = harness(logs)
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    for (let index = 0; index < 300; index += 1) logs.get('chat-1').record('in', `${index}`)
    await tick()
    const live = debugMessages(h.messages).filter(message => !message.page)
    expect(live.length).toBeGreaterThan(1)
    expect(live.every(message => message.frames.length <= 128)).toBe(true)
    expect(live.flatMap(seqsOf)).toEqual(Array.from({ length: 300 }, (_, index) => index + 1))
  })

  test('disconnect drops debug subscriptions and buffered frames', async () => {
    const logs = wireLogs()
    const h = harness(logs)
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    logs.get('chat-1').record('in', 'buffered')
    h.connections.disconnect(h.connection)
    logs.get('chat-1').record('in', 'after')
    await tick()
    expect(debugMessages(h.messages).filter(message => !message.page)).toEqual([])
  })

  test('invalid page cursors and unknown sessions are refused', async () => {
    const h = harness(wireLogs())
    await h.connections.handle(h.connection, { type: 'chat-debug-page', sessionId: 'chat-1', beforeSeq: 0 })
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'missing' })
    expect(h.messages).toEqual([
      { type: 'error', message: 'chat-debug-page needs a positive integer beforeSeq' },
      { type: 'error', message: 'Unknown chat session missing' },
    ])
  })

  test('without wire logs open replies with an empty page', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    expect(h.messages).toEqual([{ type: 'chat-debug-frames', sessionId: 'chat-1', frames: [], page: true, hasOlder: false }])
  })

  test('a page reply is dropped if the view closed while it was read', async () => {
    const logs = wireLogs()
    logs.get('chat-1').record('in', 'x')
    const h = harness(logs)
    const opening = h.connections.handle(h.connection, { type: 'chat-debug-open', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-debug-close', sessionId: 'chat-1' })
    await opening
    expect(debugMessages(h.messages)).toEqual([])
  })
})
