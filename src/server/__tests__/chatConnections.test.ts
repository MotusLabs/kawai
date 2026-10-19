import { afterAll, describe, expect, test } from 'bun:test'
import type { ChatBackgroundTask, ChatContextUsage, ChatEvent, ChatNotification, ChatWorker } from '../../shared/chat'
import type { ServerMessage } from '../../shared/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHAT_DEBUG_PAGE_SIZE, ChatConnections } from '../chat/ChatConnections'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import type { ChatActionResult, ChatSessionManager } from '../chat/ChatSessionManager'

function harness(wireLogs?: ChatWireLogs) {
  const calls: unknown[] = []
  /** Windowed-snapshot and history-page wiring, kept out of `calls` (attach tests assert it exactly). */
  const snapshotCalls: Array<{ id: string; options: unknown }> = []
  const pageCalls: Array<{ id: string; beforeId: string; throughId?: string }> = []
  const loadHistoryCalls: string[] = []
  let page: { events: ChatEvent[]; hasOlder: boolean; stale: boolean } | null = null
  const snapshot: Extract<ServerMessage, { type: 'chat-snapshot' }> = {
    type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [],
    pendingRequests: [{ kind: 'approval', requestId: 'approval-1', tool: 'Bash', input: {}, at: 'now' }],
    status: 'permission', throughSequence: 0,
    commands: { status: 'unavailable', commands: [] }, activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    historyHasOlder: true, historyStartId: 'hist-start',
  }
  let pending = true
  const manager = {
    isArchived: (_id: string) => false,
    whenRestored: () => Promise.resolve(),
    loadHistory: async (id: string) => { loadHistoryCalls.push(id) },
    has: (id: string) => id === 'chat-1' || id === 'chat-2' || id === 'chat-3' || id === 'chat-4' || id === 'chat-5',
    profileIdOf: (id: string) => (id === 'chat-2' || id === 'chat-4' ? 'glm' : id === 'chat-5' ? 'glm-flash' : 'default'),
    providerIdOf: (id: string) => (id === 'chat-2' || id === 'chat-4' || id === 'chat-5' ? 'zai' : 'default'),
    getSnapshot: (id: string, options: { historyFrom?: string } = {}) => {
      snapshotCalls.push({ id, options })
      return id === 'chat-2' ? null : { ...snapshot, sessionId: id }
    },
    getHistoryPage: (id: string, beforeId: string, throughId?: string) => {
      pageCalls.push({ id, beforeId, ...(throughId !== undefined ? { throughId } : {}) })
      return page
    },
    send: async (...args: unknown[]) => { calls.push(['send', ...args]); return { ok: true } },
    start: (...args: unknown[]) => { calls.push(['start', ...args]); return Promise.resolve<ChatActionResult>({ ok: true }) },
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
    getWorkerTranscript: (id: string, workerId: string) => {
      calls.push(['workerTranscript', id, workerId])
      return workerId === 'toolu_spawn_1'
        ? { status: 'ok', events: [delta(1)] }
        : { status: 'unavailable', events: [] }
    },
    setApprovalPolicy: (...args: unknown[]) => {
      calls.push(['setApprovalPolicy', ...args])
      const policy = args[1]
      if (policy !== 'manual' && policy !== 'auto') {
        return { ok: false, error: `Unsupported approval policy ${String(policy)}` }
      }
      return { ok: true }
    },
    dismissNotification: (...args: unknown[]) => {
      calls.push(['dismissNotification', ...args])
      return { ok: true }
    },
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager, wireLogs)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  return { connections, connection, messages, calls, snapshot, manager, snapshotCalls, pageCalls, loadHistoryCalls, setPage: (next: typeof page) => { page = next } }
}

const delta = (sequence: number, turnId = 'turn-1'): ChatEvent => ({
  type: 'assistant_delta', id: `event-${sequence}`, sequence, at: 'now', turnId, messageId: 'message-1', delta: `${sequence}`,
})

const worker = (status: 'running' | 'completed', live: boolean): ChatWorker => ({
  workerId: 'toolu_spawn_1',
  taskId: 'task_1',
  agentType: 'Explore',
  description: 'Map the workspace',
  depth: 1,
  status,
  live,
  lastTool: 'Grep',
  elapsedMs: 4_000,
})

const bgTask = (status: 'running' | 'completed', live: boolean): ChatBackgroundTask => ({
  taskId: 'b1',
  toolCallId: 'call_1',
  kind: 'shell',
  description: 'Wait for CI',
  status,
  live,
  startedAtMs: 1_000,
  ...(status === 'completed' ? { endedAtMs: 5_000 } : {}),
  elapsedMs: 4_000,
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

  test('routes approval policy switches and echoes failures to the sender', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'auto' })
    await h.connections.handle(h.connection, { type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'manual' })
    expect(h.calls).toEqual([
      ['setApprovalPolicy', 'chat-1', 'auto'],
      ['setApprovalPolicy', 'chat-1', 'manual'],
    ])
    // An unsupported value is routed to the manager, which rejects it; the
    // error echoes to the sender.
    await h.connections.handle(h.connection, { type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'yolo' as never })
    expect(h.calls.at(-1)).toEqual(['setApprovalPolicy', 'chat-1', 'yolo'])
    expect(h.messages).toEqual([{ type: 'error', message: 'Unsupported approval policy yolo' }])
    // Unknown sessions fail before reaching the manager.
    await h.connections.handle(h.connection, { type: 'chat-set-approval-policy', sessionId: 'missing', policy: 'auto' })
    expect(h.messages[1]).toMatchObject({ type: 'error' })
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

  test('worker rosters coalesce to the latest and replace, never merge', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publishWorkers('chat-1', [worker('running', true)])
    h.connections.publishWorkers('chat-1', [worker('completed', false)])
    // A roster for a session nobody subscribes to goes nowhere.
    h.connections.publishWorkers('chat-3', [worker('running', true)])
    await new Promise(resolve => setTimeout(resolve, 0))
    // One message, carrying only the latest projection (workers design D2).
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-workers', sessionId: 'chat-1', workers: [worker('completed', false)] },
    ])
    // Detach stops the flow for that connection.
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    h.connections.publishWorkers('chat-1', [worker('running', true)])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(2)
  })

  test('background-task rosters coalesce to the latest and replace, never merge', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publishBackgroundTasks('chat-1', [bgTask('running', true)])
    h.connections.publishBackgroundTasks('chat-1', [bgTask('completed', false)])
    // A roster for a session nobody subscribes to goes nowhere.
    h.connections.publishBackgroundTasks('chat-3', [bgTask('running', true)])
    await new Promise(resolve => setTimeout(resolve, 0))
    // One message, the latest full set (background tasks D2).
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-background-tasks', sessionId: 'chat-1', tasks: [bgTask('completed', false)] },
    ])
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    h.connections.publishBackgroundTasks('chat-1', [bgTask('running', true)])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(2)
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

  test('attach reports startup refusals after the history snapshot', async () => {
    const h = harness()
    h.manager.start = async () => ({ ok: false, error: 'Cannot resume: transcript missing' })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    expect(h.messages).toEqual([h.snapshot, { type: 'error', message: 'Cannot resume: transcript missing' }])
  })

  test('archived attach restores history without starting or reporting an error', async () => {
    const h = harness()
    h.manager.isArchived = () => true
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    expect(h.messages).toEqual([h.snapshot])
    expect(h.calls).toEqual([])
  })

  test('attach asks for the window and passes historyFrom through', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    expect(h.snapshotCalls).toEqual([{ id: 'chat-1', options: {} }])
    expect(h.messages[0]).toMatchObject({
      type: 'chat-snapshot', sessionId: 'chat-1', historyHasOlder: true, historyStartId: 'hist-start',
    })
    // A reconnecting client names its oldest held event; the snapshot
    // covers the same span (the manager widens, tested there).
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1', historyFrom: 'hist-start' })
    expect(h.snapshotCalls[1]).toEqual({ id: 'chat-1', options: { historyFrom: 'hist-start' } })
    h.connections.publish('chat-1', delta(7))
    await new Promise(resolve => setTimeout(resolve, 0))
    // Live events after the re-attach are neither lost nor duplicated.
    expect(h.messages.at(-1)).toEqual({ type: 'chat-events', sessionId: 'chat-1', events: [delta(7)] })
  })

  test('chat-history-page replies to the asking connection only, with throughId', async () => {
    const h = harness()
    h.setPage({ events: [delta(9)], hasOlder: true, stale: false })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-start', throughId: 'tool:call-9' })
    expect(h.loadHistoryCalls).toEqual(['chat-1', 'chat-1'])
    expect(h.pageCalls).toEqual([{ id: 'chat-1', beforeId: 'hist-start', throughId: 'tool:call-9' }])
    expect(h.messages[1]).toEqual({ type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-start', events: [delta(9)], hasOlder: true })
    expect(otherMessages).toEqual([])
  })

  test('a stale page reply carries the stale flag', async () => {
    const h = harness()
    h.setPage({ events: [], hasOlder: false, stale: true })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-drifted' })
    expect(h.messages[1]).toEqual({ type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-drifted', events: [], hasOlder: false, stale: true })
  })

  test('a page without a subscription is refused before loading history', async () => {
    const h = harness()
    h.setPage({ events: [delta(1)], hasOlder: true, stale: false })
    await h.connections.handle(h.connection, { type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-x' })
    expect(h.messages).toEqual([{ type: 'error', message: 'chat-history-page needs an active subscription to chat-1' }])
    expect(h.loadHistoryCalls).toEqual([])
    expect(h.pageCalls).toEqual([])
  })

  test('paging an archived chat starts no agent', async () => {
    const h = harness()
    h.manager.isArchived = () => true
    h.setPage({ events: [delta(5)], hasOlder: false, stale: false })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-start' })
    expect(h.calls).toEqual([])
    expect(h.messages).toHaveLength(2)
    expect(h.messages[1]).toMatchObject({ type: 'chat-history-page', hasOlder: false })
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

  test('notification dismissal routes to the manager; unknown sessions are refused', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-dismiss-notification', sessionId: 'chat-1', key: 'model-context-window' })
    expect(h.calls).toEqual([['dismissNotification', 'chat-1', 'model-context-window']])
    expect(h.messages).toEqual([])
    // Unknown sessions fail before reaching the manager.
    await h.connections.handle(h.connection, { type: 'chat-dismiss-notification', sessionId: 'missing', key: 'k' })
    expect(h.messages).toEqual([{ type: 'error', message: 'Unknown chat session missing' }])
    expect(h.calls).toHaveLength(1)
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

  test('activity follows the event it describes in the same flush', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    const toolCall: ChatEvent = {
      type: 'tool_call', id: 'event-1', sequence: 1, at: 'now', turnId: 'turn-1',
      toolCallId: 'toolu_1', tool: 'Bash', input: {},
    }
    h.connections.publish('chat-1', toolCall)
    h.connections.publishActivity('chat-1', { phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-events', sessionId: 'chat-1', events: [toolCall] },
      { type: 'chat-activity', sessionId: 'chat-1', activity: { phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 1 } },
    ])
  })

  test('several activity changes within one tick collapse to the last', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publishActivity('chat-1', { phase: 'requesting', elapsedMs: 0 })
    h.connections.publishActivity('chat-1', { phase: 'thinking', elapsedMs: 0 })
    h.connections.publishActivity('chat-1', { phase: 'retrying', elapsedMs: 0, attempt: 2, maxRetries: 10, errorStatus: 504 })
    h.connections.publishActivity('chat-1', null)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-activity', sessionId: 'chat-1', activity: null },
    ])
  })

  test('activity reaches only subscribed connections and none after detach', async () => {
    const h = harness()
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    // A browser subscribed to another session never sees this one's activity.
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-2' })
    h.connections.publishActivity('chat-1', { phase: 'thinking', elapsedMs: 0 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.at(-1)).toMatchObject({ type: 'chat-activity', activity: { phase: 'thinking' } })
    expect(otherMessages).toEqual([])

    // After detach the queued value is dropped, not delivered late.
    h.connections.publishActivity('chat-1', { phase: 'responding', elapsedMs: 0 })
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.filter(message => message.type === 'chat-activity')).toHaveLength(1)
    expect(otherMessages).toEqual([])
  })

  test('several context-usage updates within one tick collapse to one message', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    const reading = (usedTokens: number): ChatContextUsage => ({
      usedTokens,
      thresholdTokens: 200_000,
      percentage: (usedTokens / 200_000) * 100,
      at: 'now',
    })
    h.connections.publishContextUsage('chat-1', reading(40_000))
    h.connections.publishContextUsage('chat-1', reading(60_000))
    h.connections.publishContextUsage('chat-1', reading(95_000))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-context-usage', sessionId: 'chat-1', usage: reading(95_000) },
    ])

    // The next flush carries only its own latest value.
    h.connections.publishContextUsage('chat-1', reading(96_000))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(2)).toEqual([
      { type: 'chat-context-usage', sessionId: 'chat-1', usage: reading(96_000) },
    ])
  })

  test('model pushes reach only subscribed connections, latest once per flush', async () => {
    const h = harness()
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-2' })
    // Two changes inside one tick: only the latest survives the flush, once.
    h.connections.publishModel('chat-1', 'claude-sonnet-5-5')
    h.connections.publishModel('chat-1', 'sonnet')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-model', sessionId: 'chat-1', model: 'sonnet' },
    ])
    expect(otherMessages).toEqual([])

    // A later change arrives as its own message.
    h.connections.publishModel('chat-1', 'opus')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(2)).toEqual([
      { type: 'chat-model', sessionId: 'chat-1', model: 'opus' },
    ])
    expect(otherMessages).toEqual([])
  })

  test('a provider report fans out per subscribed profile, one message per profile id', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-3' })
    const report = {
      status: 'allowed' as const,
      windows: [
        { key: 'five_hour', label: '5-hour window', percentUsed: 22.37, resetsAt: '2026-10-07T18:11:04.000Z' },
        { key: 'seven_day', label: '7-day window', percentUsed: 17.12, resetsAt: null },
      ],
      receivedAt: '2026-10-07T13:00:00.000Z',
    }
    h.connections.publishUsage('default', report)
    // Several reports within one tick collapse to the latest value per session.
    h.connections.publishUsage('default', null)
    // A provider only its own sessions care about fans to those alone — two
    // sibling models of zai each get the report under their own profile id
    // (providers-and-workers 5.3).
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-4' })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-5' })
    h.connections.publishUsage('zai', report)
    await new Promise(resolve => setTimeout(resolve, 0))
    // One message per subscribed profile: the two `default` sessions collapse
    // into one message, and each sibling model of zai is named by its own
    // profile id plus the additive provider id.
    expect(h.messages.filter(message => message.type === 'chat-usage')).toEqual([
      { type: 'chat-usage', profileId: 'default', providerId: 'default', report: null },
      { type: 'chat-usage', profileId: 'glm', providerId: 'zai', report },
      { type: 'chat-usage', profileId: 'glm-flash', providerId: 'zai', report },
    ])
  })

  test('a profile message survives while a sibling session of the profile stays subscribed', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-3' })
    const report = {
      status: 'allowed' as const,
      windows: [{ key: 'five_hour', label: '5-hour window', percentUsed: 22.37, resetsAt: null }],
      receivedAt: '2026-10-07T13:00:00.000Z',
    }
    h.connections.publishUsage('default', report)
    // One of the two same-profile sessions detaches before the flush; the
    // other keeps the profile's message alive.
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-3' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.filter(message => message.type === 'chat-usage')).toEqual([
      { type: 'chat-usage', profileId: 'default', providerId: 'default', report },
    ])
  })

  test('usage reaches only connections subscribed to the changed provider', async () => {
    const h = harness()
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-2' })
    const report = {
      status: 'warning' as const,
      windows: [
        { key: 'five_hour', label: '5-hour window', percentUsed: 87, resetsAt: '2026-10-07T18:11:04.000Z' },
      ],
      receivedAt: '2026-10-07T13:00:00.000Z',
    }
    h.connections.publishUsage('default', report)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.at(-1)).toEqual({ type: 'chat-usage', profileId: 'default', providerId: 'default', report })
    expect(otherMessages).toEqual([])

    // Detaching the only session of the provider drops the queued report.
    h.connections.publishUsage('default', report)
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.filter(message => message.type === 'chat-usage')).toHaveLength(1)
  })

  test('notifications coalesce to the latest list and replace, never merge', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    const notice = (key: string, text: string): ChatNotification => ({
      key,
      source: 'agent',
      severity: 'warning',
      priority: 'high',
      text,
      receivedAt: '2026-10-12T00:00:00.000Z',
    })
    h.connections.publishNotifications('chat-1', [notice('a', 'one')])
    h.connections.publishNotifications('chat-1', [notice('a', 'two'), notice('b', 'three')])
    // A list for a session nobody subscribes to goes nowhere.
    h.connections.publishNotifications('chat-3', [notice('c', 'orphan')])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      {
        type: 'chat-notifications',
        sessionId: 'chat-1',
        notifications: [notice('a', 'two'), notice('b', 'three')],
      },
    ])
    // The subscribed-session scope is live for the recheck timer.
    expect(h.connections.subscribedSessionIds()).toEqual(new Set(['chat-1']))
    // Detach stops the flow for that connection.
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    h.connections.publishNotifications('chat-1', [notice('a', 'after')])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(2)
    expect(h.connections.subscribedSessionIds()).toEqual(new Set())
  })
})

describe('chat attach across async restore and history', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const gate = () => {
    let open!: () => void
    const promise = new Promise<void>(resolve => { open = resolve })
    return { promise, open }
  }
  type Stubbed = { whenRestored: () => Promise<void>; loadHistory: (id: string) => Promise<void>; has: (id: string) => boolean }

  test('messages wait for the boot restore, in arrival order', async () => {
    const h = harness()
    const restore = gate()
    let restored = false
    const manager = h.manager as unknown as Stubbed
    manager.whenRestored = () => restore.promise
    manager.has = id => restored && id === 'chat-1'
    const attach = h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    const send = h.connections.handle(h.connection, { type: 'chat-send', sessionId: 'chat-1', text: 'hi' })
    await tick()
    expect(h.messages).toEqual([])
    restored = true
    restore.open()
    await Promise.all([attach, send])
    expect(h.messages.map(message => message.type)).toEqual(['chat-snapshot'])
    expect(h.calls).toEqual([['send', 'chat-1', 'hi'], ['start', 'chat-1']])
  })

  test('a detach sent while the attach loads history wins', async () => {
    const h = harness()
    const history = gate()
    ;(h.manager as unknown as Stubbed).loadHistory = () => history.promise
    const attach = h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    history.open()
    await attach
    h.connections.publish('chat-1', delta(1))
    await tick()
    expect(h.messages).toEqual([])
    expect(h.calls).toEqual([])
  })

  test('of two attaches racing their history loads only the latest subscribes', async () => {
    const h = harness()
    const loads = [gate(), gate()]
    let call = 0
    ;(h.manager as unknown as Stubbed).loadHistory = () => loads[call++]!.promise
    const first = h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await tick()
    const second = h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await tick()
    loads[1]!.open(); await second
    loads[0]!.open(); await first
    expect(h.messages.map(message => message.type)).toEqual(['chat-snapshot'])
    expect(h.calls).toEqual([['start', 'chat-1']])
  })

  test('a disconnect while the attach loads history drops it', async () => {
    const h = harness()
    const history = gate()
    ;(h.manager as unknown as Stubbed).loadHistory = () => history.promise
    const attach = h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await tick()
    h.connections.disconnect(h.connection)
    history.open()
    await attach
    h.connections.publish('chat-1', delta(1))
    await tick()
    expect(h.messages).toEqual([])
    expect(h.calls).toEqual([])
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

describe('chat worker transcript requests', () => {
  test('replies to the asking connection only, ok or unavailable', async () => {
    const h = harness()
    const otherMessages: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => otherMessages.push(message) }
    await h.connections.handle(other, { type: 'chat-attach', sessionId: 'chat-1' })
    otherMessages.length = 0

    await h.connections.handle(h.connection, { type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_spawn_1' })
    await h.connections.handle(h.connection, { type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_gone' })
    expect(h.messages).toEqual([
      { type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_spawn_1', status: 'ok', events: [delta(1)] },
      { type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_gone', status: 'unavailable', events: [] },
    ])
    expect(otherMessages).toEqual([])
  })

  test('an unknown session is refused without reading', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-worker-transcript', sessionId: 'nope', workerId: 'toolu_spawn_1' })
    expect(h.messages).toEqual([{ type: 'error', message: 'Unknown chat session nope' }])
    expect(h.calls.filter(call => (call as unknown[])[0] === 'workerTranscript')).toEqual([])
  })
})
