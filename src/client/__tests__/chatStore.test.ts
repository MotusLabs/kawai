import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatBackgroundTask, ChatContextUsage, ChatEvent, ChatNotification } from '@shared/chat'
import type { ClientMessage } from '@shared/types'
import { applyChatEvents, emptyTranscript, useChatStore } from '../stores/chatStore'

const delta = (sequence: number, delta: string): Extract<ChatEvent, { type: 'assistant_delta' }> => ({
  type: 'assistant_delta', id: `event-${sequence}`, sequence, at: 'now', turnId: 'turn-1', messageId: 'message-1', delta,
})
afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

describe('chat store', () => {
  test('ordered deltas merge and final text replaces the preview', () => {
    const first = applyChatEvents(emptyTranscript(), [delta(1, 'Hel'), delta(2, 'lo')])
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ type: 'assistant_text', text: 'Hello' })
    const final: ChatEvent = { ...delta(3, ''), type: 'assistant_text', text: 'Hello!' }
    const next = applyChatEvents(first, [final])
    expect(next.events).toHaveLength(1)
    expect(next.events[0]).toMatchObject({ text: 'Hello!' })
    expect(first.events[0]).toMatchObject({ text: 'Hello' })
  })

  test('text after a tool call in one message is its own entry, in order (D5)', () => {
    const text = (sequence: number, value: string): ChatEvent => ({ ...delta(sequence, ''), type: 'assistant_text', text: value })
    const tool: ChatEvent = { id: 'tool', sequence: 4, at: 'now', type: 'tool_call', turnId: 'turn-1', toolCallId: 'c1', tool: 'Read', input: {} }
    const state = applyChatEvents(emptyTranscript(), [
      delta(1, 'Look'), delta(2, 'ing'), text(3, 'Looking'), tool, delta(5, 'Fo'), delta(6, 'und'), text(7, 'Found'),
    ])
    expect(state.events.map(event => event.type === 'assistant_text' ? event.text : event.type)).toEqual(['Looking', 'tool_call', 'Found'])
  })

  test('replayed blocks of one message keep their order around a tool call (D5)', () => {
    const block = (id: string, value: string): ChatEvent =>
      ({ id, sequence: 0, at: '2026-10-16T10:00:00.000Z', type: 'assistant_text', turnId: 'hist-turn-1', messageId: 'msg', text: value })
    const tool: ChatEvent = { id: 'hist-tool', sequence: 0, at: '2026-10-16T10:00:01.000Z', type: 'tool_call', turnId: 'hist-turn-1', toolCallId: 'c1', tool: 'Read', input: {} }
    const state = applyChatEvents(emptyTranscript(), [block('a', 'First'), tool, block('b', 'Second')])
    expect(state.events.map(event => event.type === 'assistant_text' ? event.text : event.type)).toEqual(['First', 'tool_call', 'Second'])
  })

  test('adjacent text blocks of one message still merge: events carry no block index (D5 limitation)', () => {
    const state = applyChatEvents(emptyTranscript(), [delta(1, 'One'), { ...delta(2, ''), type: 'assistant_text', text: 'Two' }])
    expect(state.events).toHaveLength(1)
  })

  test('an entry keeps its first valid time through deltas, its final text, and a replay of the same ids (D2)', () => {
    const at = (sequence: number, time: string) => ({ ...delta(sequence, `${sequence}`), at: time })
    const streamed = applyChatEvents(emptyTranscript(), [
      at(1, '2026-10-16T10:00:00.000Z'), at(2, '2026-10-16T10:00:03.000Z'),
    ])
    const final = applyChatEvents(streamed, [{ ...delta(3, ''), type: 'assistant_text', text: '12', at: '2026-10-16T10:00:09.000Z' }])
    expect(final.events[0]?.at).toBe('2026-10-16T10:00:00.000Z')
    // Reattach: the snapshot replays the same events into a fresh transcript.
    const reattached = applyChatEvents(emptyTranscript(), [
      at(1, '2026-10-16T10:00:00.000Z'), at(2, '2026-10-16T10:00:03.000Z'),
      { ...delta(3, ''), type: 'assistant_text', text: '12', at: '2026-10-16T10:00:09.000Z' },
    ])
    expect(reattached.events[0]?.at).toBe('2026-10-16T10:00:00.000Z')
  })

  test('an unknown first time gives way to the first valid one', () => {
    const state = applyChatEvents(emptyTranscript(), [{ ...delta(1, 'a'), at: '' }, { ...delta(2, 'b'), at: '2026-10-16T10:00:03.000Z' }])
    expect(state.events[0]?.at).toBe('2026-10-16T10:00:03.000Z')
  })

  test('duplicate ids and old sequences are ignored', () => {
    const first = applyChatEvents(emptyTranscript(), [delta(1, 'Hello')])
    const next = applyChatEvents(first, [delta(1, 'Hello'), { ...delta(1, 'duplicate'), id: 'other-id' }])
    expect(next.events).toEqual(first.events)
  })

  test('approvals and questions are removed by resolution and cancellation', () => {
    const approval: ChatEvent = { id: 'a', sequence: 1, at: 'now', turnId: 't', type: 'approval_request', requestId: 'r1', tool: 'Bash', input: {} }
    const question: ChatEvent = { id: 'q', sequence: 2, at: 'now', turnId: 't', type: 'question_request', requestId: 'r2', questions: [] }
    const pending = applyChatEvents(emptyTranscript(), [approval, question])
    expect(pending.pendingRequests.map(request => request.kind)).toEqual(['approval', 'question'])
    expect(pending.status).toBe('permission')
    const resolved = applyChatEvents(pending, [{ id: 'r', sequence: 3, at: 'now', type: 'request_resolved', requestId: 'r1', outcome: 'allowed' }])
    expect(resolved.pendingRequests).toHaveLength(1)
    expect(resolved.status).toBe('permission')
    const cancelled = applyChatEvents(resolved, [{ id: 'c', sequence: 4, at: 'now', type: 'request_resolved', requestId: 'r2', outcome: 'cancelled' },
      { id: 's', sequence: 5, at: 'now', type: 'turn_interrupted', turnId: 't' }])
    expect(cancelled.pendingRequests).toEqual([])
    expect(cancelled.status).toBe('waiting')
  })

  test('a policy grant with no prior card leaves pending requests and status intact', () => {
    // Auto policy resolves tool uses that never showed a card; the store
    // must not disturb unrelated pending requests or reset status.
    const approval: ChatEvent = { id: 'a', sequence: 1, at: 'now', turnId: 't', type: 'approval_request', requestId: 'r1', tool: 'Bash', input: {} }
    const pending = applyChatEvents(emptyTranscript(), [approval])
    const granted = applyChatEvents(pending, [
      { id: 'g', sequence: 2, at: 'now', type: 'request_resolved', requestId: 'req-unseen', outcome: 'allowed', decidedBy: 'policy', tool: 'Write' },
    ])
    expect(granted.pendingRequests.map(request => request.requestId)).toEqual(['r1'])
    expect(granted.status).toBe('permission')
    expect(granted.events.at(-1)).toMatchObject({ type: 'request_resolved', decidedBy: 'policy', tool: 'Write' })
    // With nothing pending the same event keeps the working status.
    const lone = applyChatEvents(emptyTranscript(), [
      { id: 's', sequence: 1, at: 'now', type: 'turn_started', turnId: 't' },
      { id: 'g', sequence: 2, at: 'now', type: 'request_resolved', requestId: 'req-unseen', outcome: 'allowed', decidedBy: 'policy', tool: 'Write' },
    ])
    expect(lone.status).toBe('working')
  })

  test('a snapshot replaces stale state and its pending requests are authoritative', () => {
    const store = useChatStore.getState()
    store.apply('chat-1', [delta(1, 'old')])
    store.snapshot({ type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [delta(2, 'restored')], pendingRequests: [], status: 'working', throughSequence: 2, commands: { status: 'ready', commands: [] }, activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null })
    const state = useChatStore.getState().sessions['chat-1']
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({ text: 'restored' })
    store.apply('chat-1', [delta(2, 'restored'), delta(3, '!')])
    expect(useChatStore.getState().sessions['chat-1'].events[0]).toMatchObject({ text: 'restored!' })
  })

  test('command state defaults to unavailable, replaces on push, and reconnect restores it', () => {
    const store = useChatStore.getState()
    expect(emptyTranscript().commands).toEqual({ status: 'unavailable', commands: [] })
    // A push may precede the snapshot (attach sends the snapshot, then starts
    // the agent): the transcript materializes with the pushed state.
    store.setCommands({
      type: 'chat-commands', sessionId: 'chat-1',
      state: { status: 'loading', commands: [] },
    })
    expect(useChatStore.getState().sessions['chat-1'].commands).toEqual({ status: 'loading', commands: [] })

    const usage = { name: 'usage', description: 'costs', aliases: [], source: 'builtin' as const }
    store.setCommands({
      type: 'chat-commands', sessionId: 'chat-1',
      state: { status: 'ready', commands: [usage] },
    })
    // Replace semantics: the earlier list is gone, the transcript untouched.
    expect(useChatStore.getState().sessions['chat-1'].commands).toEqual({ status: 'ready', commands: [usage] })
    expect(useChatStore.getState().sessions['chat-1'].events).toEqual([])

    // Reconnect: the snapshot's state is authoritative again.
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [], pendingRequests: [],
      status: 'waiting', throughSequence: 0, commands: { status: 'ready', commands: [usage] }, activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    expect(useChatStore.getState().sessions['chat-1'].commands).toEqual({ status: 'ready', commands: [usage] })

    // Other sessions are untouched.
    expect(useChatStore.getState().sessions['chat-2']).toBeUndefined()
  })

  test('replayed history remains ordered despite sequence zero and is deduplicated by id', () => {
    const first = { ...delta(0, 'history'), id: 'history-a' }
    const second = { ...delta(0, ' more'), id: 'history-b' }
    const state = applyChatEvents(emptyTranscript(), [first, second, first])
    expect(state.events[0]).toMatchObject({ text: 'history more' })
    expect(state.seen.size).toBe(2)
  })

  test('kill clears only the removed session', () => {
    const store = useChatStore.getState()
    store.apply('chat-1', [delta(1, 'one')])
    store.apply('chat-2', [delta(1, 'two')])
    store.remove('chat-1')
    expect(useChatStore.getState().sessions['chat-1']).toBeUndefined()
    expect(useChatStore.getState().sessions['chat-2'].events).toHaveLength(1)
  })
})

describe('chat store drafts', () => {
  test('setDraft writes, overwrites, and deletes the key on empty', () => {
    const store = useChatStore.getState()
    store.setDraft('chat-1', 'hello')
    expect(useChatStore.getState().drafts['chat-1']).toBe('hello')
    store.setDraft('chat-1', 'hello there')
    expect(useChatStore.getState().drafts['chat-1']).toBe('hello there')
    store.setDraft('chat-1', '')
    expect(useChatStore.getState().drafts).not.toHaveProperty('chat-1')
    // Other sessions keep their drafts.
    store.setDraft('chat-2', 'kept')
    store.setDraft('chat-1', '')
    expect(useChatStore.getState().drafts['chat-2']).toBe('kept')
  })

  test('apply and snapshot leave drafts untouched', () => {
    const store = useChatStore.getState()
    store.setDraft('chat-1', 'in progress')
    store.apply('chat-1', [delta(1, 'streamed')])
    store.snapshot({ type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [delta(2, 'restored')], pendingRequests: [], status: 'working', throughSequence: 2, activity: null, contextUsage: null, commands: { status: 'unavailable', commands: [] }, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null })
    expect(useChatStore.getState().drafts['chat-1']).toBe('in progress')
  })

  test('remove discards the session draft but keeps other sessions\'', () => {
    const store = useChatStore.getState()
    store.setDraft('chat-1', 'mine')
    store.setDraft('chat-2', 'theirs')
    store.remove('chat-1')
    expect(useChatStore.getState().drafts).not.toHaveProperty('chat-1')
    expect(useChatStore.getState().drafts['chat-2']).toBe('theirs')
  })
})

describe('chat store activity', () => {
  test('setActivity anchors the phase on the client clock and clears on null', () => {
    const store = useChatStore.getState()
    const before = Date.now()
    store.setActivity('chat-1', { phase: 'thinking', elapsedMs: 5_000 })
    const anchored = useChatStore.getState().sessions['chat-1'].activity!
    const after = Date.now()
    expect(anchored.value).toEqual({ phase: 'thinking', elapsedMs: 5_000 })
    expect(anchored.phaseStartedAt).toBeGreaterThanOrEqual(before - 5_000)
    expect(anchored.phaseStartedAt).toBeLessThanOrEqual(after - 5_000)

    store.setActivity('chat-1', null)
    expect(useChatStore.getState().sessions['chat-1'].activity).toBeNull()
  })

  test('a snapshot restores the in-flight activity with its age', () => {
    const store = useChatStore.getState()
    const before = Date.now()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [delta(1, 'streamed')],
      pendingRequests: [], status: 'working', throughSequence: 1,
      commands: { status: 'ready', commands: [] },
      activity: { phase: 'running_tools', elapsedMs: 10_000, tool: 'Bash', count: 1 },
      contextUsage: null,
      usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    const activity = useChatStore.getState().sessions['chat-1'].activity!
    expect(activity.value.phase).toBe('running_tools')
    expect(activity.phaseStartedAt).toBeGreaterThanOrEqual(before - 10_000)
    // An idle snapshot carries no row.
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-2', profileId: 'default', events: [], pendingRequests: [],
      status: 'waiting', throughSequence: 0, commands: { status: 'unavailable', commands: [] }, activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    expect(useChatStore.getState().sessions['chat-2'].activity).toBeNull()
  })

  test('turn end events clear the row even without a server null', () => {
    const store = useChatStore.getState()
    store.setActivity('chat-1', { phase: 'thinking', elapsedMs: 1_000 })
    store.apply('chat-1', [
      { id: 'done', sequence: 9, at: 'now', turnId: 'turn-1', type: 'turn_completed', subtype: 'success' },
    ])
    expect(useChatStore.getState().sessions['chat-1'].activity).toBeNull()

    store.setActivity('chat-1', { phase: 'thinking', elapsedMs: 1_000 })
    store.apply('chat-1', [
      { id: 'stop', sequence: 10, at: 'now', turnId: 'turn-2', type: 'turn_interrupted' },
    ])
    expect(useChatStore.getState().sessions['chat-1'].activity).toBeNull()
  })
})

describe('chat store usage', () => {
  const report = {
    status: 'allowed' as const,
    windows: [
      { key: 'five_hour', label: '5-hour window', percentUsed: 22.37, resetsAt: '2026-10-07T18:11:04.000Z' },
      { key: 'seven_day', label: '7-day window', percentUsed: 17.12, resetsAt: null },
    ],
    receivedAt: '2026-10-07T13:00:00.000Z',
  }

  afterEach(() => useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {} }))

  test('snapshots and pushes land in one per-profile map', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: report, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    expect(useChatStore.getState().usage['default']).toEqual(report)

    // A push updates the same shared slot whatever session produced it.
    store.setUsage('default', null)
    expect(useChatStore.getState().usage['default']).toBeNull()

    // Other profiles are untouched.
    expect(useChatStore.getState().usage['glm']).toBeUndefined()
  })

  test('an attach-time snapshot is authoritative for its profile', () => {
    const store = useChatStore.getState()
    store.setUsage('default', report)
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null, // restart: the server held nothing
    })
    expect(useChatStore.getState().usage['default']).toBeNull()
  })

  test('removing a session keeps the profile usage for its siblings', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: report, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    store.remove('chat-1')
    expect(useChatStore.getState().sessions['chat-1']).toBeUndefined()
    expect(useChatStore.getState().usage['default']).toEqual(report)
  })
})

describe('chat store context usage', () => {
  const reading = (usedTokens: number): ChatContextUsage => ({
    usedTokens,
    thresholdTokens: 200_000,
    percentage: usedTokens / 2_000,
    at: '2026-10-10T12:00:00.000Z',
  })

  afterEach(() => useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {} }))

  test('snapshots and live pushes replace the reading; a null snapshot clears it', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'working', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: reading(60_000), usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    expect(useChatStore.getState().sessions['chat-1'].contextUsage).toEqual(reading(60_000))

    // A coalesced push replaces the snapshot's value.
    store.setContextUsage('chat-1', reading(90_000))
    expect(useChatStore.getState().sessions['chat-1'].contextUsage).toEqual(reading(90_000))

    // A push ahead of any snapshot materializes a transcript, losing nothing.
    store.setContextUsage('chat-2', reading(10_000))
    expect(useChatStore.getState().sessions['chat-2'].contextUsage).toEqual(reading(10_000))

    // The clearing case: a snapshot with no reading (a restart, or a session
    // that never produced one) is authoritative, not merged.
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
    expect(useChatStore.getState().sessions['chat-1'].contextUsage).toBeNull()
  })

  test('transcript events never touch the reading', () => {
    const store = useChatStore.getState()
    store.setContextUsage('chat-1', reading(50_000))
    store.apply('chat-1', [delta(1, 'streaming')])
    expect(useChatStore.getState().sessions['chat-1'].contextUsage).toEqual(reading(50_000))
    expect(useChatStore.getState().sessions['chat-1'].events).toHaveLength(1)
  })

  test('a null push clears the reading (a conversation reset)', () => {
    const store = useChatStore.getState()
    store.setContextUsage('chat-1', reading(50_000))
    store.setContextUsage('chat-1', null)
    expect(useChatStore.getState().sessions['chat-1'].contextUsage).toBeNull()
  })
})

describe('chat store model', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {} }))

  test('a snapshot seeds the model and a push replaces it', () => {
    const store = useChatStore.getState()
    // Before any report: an explicit null, not undefined.
    expect(emptyTranscript().model).toBeNull()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [],
      model: 'claude-sonnet-5-5',
    })
    expect(useChatStore.getState().sessions['chat-1'].model).toBe('claude-sonnet-5-5')

    // A /model switch push replaces the snapshot's value.
    store.setModel('chat-1', 'sonnet')
    expect(useChatStore.getState().sessions['chat-1'].model).toBe('sonnet')
  })

  test('a push ahead of any snapshot materializes a transcript that a reconnect keeps current', () => {
    const store = useChatStore.getState()
    store.setModel('chat-2', 'claude-opus-5-5')
    expect(useChatStore.getState().sessions['chat-2'].model).toBe('claude-opus-5-5')

    // Reconnect: the snapshot is authoritative and carries the latest value.
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-2', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [],
      model: 'claude-opus-5-5',
    })
    expect(useChatStore.getState().sessions['chat-2'].model).toBe('claude-opus-5-5')

    // Transcript events never touch the model.
    store.apply('chat-2', [delta(1, 'streaming')])
    expect(useChatStore.getState().sessions['chat-2'].model).toBe('claude-opus-5-5')
  })
})

describe('chat store workers', () => {
  const rosterWorker = (live: boolean, elapsedMs: number) => ({
    workerId: 'toolu_spawn_1',
    taskId: 'task_1',
    agentType: 'Explore',
    description: 'Map the workspace',
    depth: 1 as const,
    status: live ? ('running' as const) : ('completed' as const),
    live,
    lastTool: 'Grep',
    elapsedMs,
  })

  afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, closedAccountNotices: {} }))

  test('snapshots and pushes anchor each row on the client clock', () => {
    const store = useChatStore.getState()
    const before = Date.now()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'working', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null,
      workers: [rosterWorker(true, 4_000)], backgroundTasks: [], notifications: [], model: null,
    })
    const after = Date.now()
    const anchored = useChatStore.getState().sessions['chat-1'].workers[0]!
    expect(anchored.startedAt).toBeGreaterThanOrEqual(before - 4_000)
    expect(anchored.startedAt).toBeLessThanOrEqual(after - 4_000)
    expect(anchored.workerId).toBe('toolu_spawn_1')

    // A push replaces the whole roster (level semantics, design D2).
    store.setWorkers('chat-1', [rosterWorker(false, 9_000)])
    const settled = useChatStore.getState().sessions['chat-1'].workers[0]!
    expect(settled.live).toBe(false)
    expect(settled.status).toBe('completed')

    // A push ahead of any snapshot materializes a transcript, losing nothing.
    store.setWorkers('chat-2', [rosterWorker(true, 1_000)])
    expect(useChatStore.getState().sessions['chat-2'].workers).toHaveLength(1)
  })

  test('worker bodies fetch once, adopt their reply, and clear with the session', () => {
    const store = useChatStore.getState()
    // First request wins; repeats (re-toggles) never re-send.
    expect(store.requestWorkerBody('chat-1', 'toolu_spawn_1')).toBe(true)
    expect(store.requestWorkerBody('chat-1', 'toolu_spawn_1')).toBe(false)
    expect(useChatStore.getState().workerBodies['chat-1']!.toolu_spawn_1).toEqual({ status: 'fetching' })

    // The reply adopts, ok or unavailable.
    store.setWorkerBody({
      type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_spawn_1',
      status: 'ok',
      events: [{ id: 'w1', sequence: 0, at: 'now', turnId: 't', type: 'user_message', text: 'map it' }],
    })
    expect(useChatStore.getState().workerBodies['chat-1']!.toolu_spawn_1).toEqual({
      status: 'ok',
      events: [{ id: 'w1', sequence: 0, at: 'now', turnId: 't', type: 'user_message', text: 'map it' }],
    })
    store.setWorkerBody({
      type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_none',
      status: 'unavailable', events: [],
    })
    expect(useChatStore.getState().workerBodies['chat-1']!.toolu_none).toEqual({ status: 'unavailable' })

    // Kill clears only the removed session's bodies.
    store.remove('chat-1')
    expect(useChatStore.getState().workerBodies['chat-1']).toBeUndefined()
  })

  test('a stranded fetch marker rolls back so the worker body can be requested again', () => {
    const store = useChatStore.getState()
    store.requestWorkerBody('chat-1', 'toolu_spawn_1')
    store.requestWorkerBody('chat-1', 'toolu_settled')
    store.setWorkerBody({
      type: 'chat-worker-transcript', sessionId: 'chat-1', workerId: 'toolu_settled',
      status: 'unavailable', events: [],
    })
    // A dead socket strands the fetch: only a still-fetching marker rolls back.
    store.resetWorkerBody('chat-1', 'toolu_spawn_1')
    expect(useChatStore.getState().workerBodies['chat-1']!.toolu_spawn_1).toBeUndefined()
    expect(store.requestWorkerBody('chat-1', 'toolu_spawn_1')).toBe(true)
    // A settled reply is final; reset leaves it alone.
    store.resetWorkerBody('chat-1', 'toolu_settled')
    expect(useChatStore.getState().workerBodies['chat-1']!.toolu_settled).toEqual({ status: 'unavailable' })
  })
})

describe('chat store notifications', () => {
  const accountNotice = (text = 'Your login expires in 2 days'): ChatNotification => ({
    key: 'login-expiry', source: 'account', severity: 'warning', priority: 'high', text,
    hint: 'run /login in a Claude terminal to renew', receivedAt: '2026-10-12T00:00:00.000Z',
  })
  const agentNotice = (key = 'model-context-window'): ChatNotification => ({
    key, source: 'agent', severity: 'warning', priority: 'high', text: 'Context low',
    receivedAt: '2026-10-12T00:00:01.000Z',
  })
  const sent: ClientMessage[] = []
  const send = (message: ClientMessage) => { sent.push(message) }

  afterEach(() => {
    useChatStore.setState({ sessions: {}, closedAccountNotices: {} })
    sent.length = 0
  })

  test('a snapshot and pushes replace the list wholesale', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [], pendingRequests: [],
      status: 'waiting', throughSequence: 0, commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [],
      backgroundTasks: [],
      notifications: [accountNotice(), agentNotice()],
      model: null,
    })
    expect(useChatStore.getState().sessions['chat-1']!.notifications).toHaveLength(2)
    store.setNotifications('chat-1', [agentNotice()])
    expect(useChatStore.getState().sessions['chat-1']!.notifications).toEqual([agentNotice()])
    store.setNotifications('chat-1', [])
    expect(useChatStore.getState().sessions['chat-1']!.notifications).toEqual([])
    // Other sessions are untouched.
    expect(useChatStore.getState().sessions['chat-2']).toBeUndefined()
  })

  test('closing an agent notice sends the dismiss message', () => {
    const store = useChatStore.getState()
    store.setNotifications('chat-1', [agentNotice()])
    store.closeNotification('chat-1', agentNotice(), send)
    expect(sent).toEqual([
      { type: 'chat-dismiss-notification', sessionId: 'chat-1', key: 'model-context-window' },
    ])
  })

  test('closing an account notice hides it in this tab until its text changes', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default', events: [], pendingRequests: [],
      status: 'waiting', throughSequence: 0, commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null, workers: [],
      backgroundTasks: [],
      notifications: [accountNotice(), agentNotice()],
      model: null,
    })
    store.closeNotification('chat-1', accountNotice(), send)
    // Nothing was sent to the server; the visible list hides it right away,
    // the agent one stays, and a later push re-hides the account one.
    expect(sent).toEqual([])
    expect(useChatStore.getState().sessions['chat-1']!.notifications).toEqual([agentNotice()])
    store.setNotifications('chat-1', [accountNotice(), agentNotice()])
    expect(useChatStore.getState().sessions['chat-1']!.notifications).toEqual([agentNotice()])
    // A new day count changes the text: the notice shows again.
    store.setNotifications('chat-1', [accountNotice('Your login expires in 1 day')])
    expect(useChatStore.getState().sessions['chat-1']!.notifications.map((notice) => notice.text))
      .toEqual(['Your login expires in 1 day'])
  })

  test('removing the session drops its closed-account keys', () => {
    const store = useChatStore.getState()
    store.setNotifications('chat-1', [accountNotice()])
    store.closeNotification('chat-1', accountNotice(), send)
    expect(useChatStore.getState().closedAccountNotices['chat-1']?.size).toBe(1)
    store.remove('chat-1')
    expect(useChatStore.getState().closedAccountNotices['chat-1']).toBeUndefined()
  })
})

describe('chat store background tasks', () => {
  const task = (overrides: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask => ({
    taskId: 'b1',
    toolCallId: 'call_1',
    kind: 'shell' as const,
    description: 'Wait for CI',
    status: 'running' as const,
    live: true,
    startedAtMs: 1_000,
    elapsedMs: 4_000,
    ...overrides,
  })

  afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, closedAccountNotices: {} }))

  test('snapshots and pushes replace the roster wholesale; sessions are independent', () => {
    const store = useChatStore.getState()
    store.snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] },
      activity: null, contextUsage: null, usage: null,
      workers: [], backgroundTasks: [task()], notifications: [], model: null,
    })
    // Epoch timestamps ride along for client-side ticking (D2).
    expect(useChatStore.getState().sessions['chat-1'].backgroundTasks[0]).toMatchObject({
      taskId: 'b1', startedAtMs: 1_000, live: true,
    })

    // A push replaces, never merges (level semantics).
    store.setBackgroundTasks('chat-1', [task({ status: 'completed', live: false, endedAtMs: 5_000 })])
    const roster = useChatStore.getState().sessions['chat-1'].backgroundTasks
    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ status: 'completed', live: false })

    // Another session's roster stays its own.
    store.setBackgroundTasks('chat-2', [task({ taskId: 'b2', description: 'dev server' })])
    expect(useChatStore.getState().sessions['chat-2'].backgroundTasks[0]).toMatchObject({ taskId: 'b2' })
    expect(useChatStore.getState().sessions['chat-1'].backgroundTasks[0]).toMatchObject({ taskId: 'b1' })
  })
})

describe('chat store history pages (chat-history-window 3.1)', () => {
  const replayed = (id: string, text: string): ChatEvent => ({
    type: 'user_message', id, sequence: 0, at: '2026-10-16T10:00:00.000Z', turnId: `turn-${id}`, text,
  })
  type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
  const snapshotMessage = (overrides: Partial<SnapshotMessage> = {}) => ({
    type: 'chat-snapshot' as const, sessionId: 'chat-1', profileId: 'default', events: [],
    pendingRequests: [], status: 'waiting' as const, throughSequence: 0,
    commands: { status: 'unavailable' as const, commands: [] }, activity: null, contextUsage: null,
    usage: null, workers: [], backgroundTasks: [], notifications: [], model: null, ...overrides,
  })
  const seedWindow = () => {
    const store = useChatStore.getState()
    store.snapshot(snapshotMessage({
      events: [delta(1, 'live'), { ...delta(2, ''), id: 'event-2', type: 'assistant_text', text: 'recent' }],
      throughSequence: 5,
      historyHasOlder: true,
      historyStartId: 'hist-a',
    }))
  }
  const sent: ClientMessage[] = []
  const send = (message: ClientMessage) => { sent.push(message) }

  test('a snapshot adopts the window fields and preserves the user expansion', () => {
    seedWindow()
    const transcript = useChatStore.getState().sessions['chat-1']!
    expect(transcript.historyHasOlder).toBe(true)
    expect(transcript.historyStartId).toBe('hist-a')
    expect(transcript.historyLoading).toBe(false)
    expect(transcript.historyExpanded).toBe(false)
    // A snapshot without the fields (an older server) reads false/null.
    useChatStore.getState().snapshot(snapshotMessage())
    const bare = useChatStore.getState().sessions['chat-1']!
    expect(bare.historyHasOlder).toBe(false)
    expect(bare.historyStartId).toBeNull()
  })

  test('requestOlder claims once, composes the request, and refuses without older history', () => {
    seedWindow()
    const store = useChatStore.getState()
    const request = store.requestOlder('chat-1')
    expect(request).toEqual({ type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a' })
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(true)
    // One page in flight: the second claim is refused.
    expect(useChatStore.getState().requestOlder('chat-1')).toBeNull()
    // A reveal widens its one request with the anchor.
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a', events: [replayed('hist-0', 'older')], hasOlder: true,
    })
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(false)
    const widened = useChatStore.getState().requestOlder('chat-1', 'tool:call-9')
    expect(widened).toEqual({ type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-0', throughId: 'tool:call-9' })
    // Nothing older: no request at all.
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-0', events: [], hasOlder: false,
    })
    expect(useChatStore.getState().requestOlder('chat-1')).toBeNull()
  })

  test('a page prepends de-duplicated and older live events never move throughSequence', () => {
    seedWindow()
    const store = useChatStore.getState()
    store.applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a',
      // An older live event (sequence > 0 but ≤ throughSequence) rides the page.
      events: [{ ...delta(3, 'old-live'), id: 'event-old' }, replayed('hist-0', 'older')],
      hasOlder: true,
    })
    const transcript = useChatStore.getState().sessions['chat-1']!
    expect(transcript.events.map(event => event.id)).toEqual(['event-old', 'hist-0', 'event-2'])
    expect(transcript.throughSequence).toBe(5)
    expect(transcript.historyHasOlder).toBe(true)
    expect(transcript.historyStartId).toBe('event-old')
    expect(transcript.historyLoading).toBe(false)
    expect(transcript.historyExpanded).toBe(true)
    // The old live event in the page did not poison the filter: a new live
    // event above throughSequence still lands, one below stays skipped.
    const live = (sequence: number, text: string): ChatEvent => ({
      type: 'user_message', id: `event-${sequence}`, sequence, at: 'now', turnId: `turn-live-${sequence}`, text,
    })
    store.apply('chat-1', [live(9, 'new')])
    store.apply('chat-1', [live(4, 'stale')])
    expect(useChatStore.getState().sessions['chat-1']!.events.map(event => event.id)).toEqual([
      'event-old', 'hist-0', 'event-2', 'event-9',
    ])
    // A reply already held is dropped by seen, the rest still prepends.
    store.applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'event-old',
      events: [replayed('hist-0', 'older'), replayed('hist-00', 'oldest')],
      hasOlder: false,
    })
    const deduped = useChatStore.getState().sessions['chat-1']!
    expect(deduped.events.filter(event => event.id === 'hist-0')).toHaveLength(1)
    expect(deduped.events[0]!.id).toBe('hist-00')
    expect(deduped.historyHasOlder).toBe(false)
  })

  test('a stale reply re-attaches plain and drops the expansion', () => {
    seedWindow()
    const store = useChatStore.getState()
    expect(store.requestOlder('chat-1')).not.toBeNull()
    sent.length = 0
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a', events: [], hasOlder: false, stale: true,
    }, send)
    expect(sent).toEqual([{ type: 'chat-attach', sessionId: 'chat-1' }])
    const transcript = useChatStore.getState().sessions['chat-1']!
    expect(transcript.historyLoading).toBe(false)
    expect(transcript.historyExpanded).toBe(false)
  })

  test('a page whose beforeId no longer matches the window start is dropped', () => {
    seedWindow()
    expect(useChatStore.getState().requestOlder('chat-1')).not.toBeNull()
    // The window start moved while the page flew (a reopen's snapshot took
    // a newer span): prepending would leave a gap, so the page is dropped
    // and the claim is released for a fresh request from the new start.
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-drifted',
      events: [replayed('hist-x', 'from the old start')], hasOlder: true,
    })
    const transcript = useChatStore.getState().sessions['chat-1']!
    expect(transcript.events.some(event => event.id === 'hist-x')).toBe(false)
    expect(transcript.historyLoading).toBe(false)
    expect(transcript.historyExpanded).toBe(false)
    expect(transcript.historyStartId).toBe('hist-a')
    // The next claim composes from the unchanged window start again.
    expect(useChatStore.getState().requestOlder('chat-1'))
      .toEqual({ type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a' })
  })

  test('loading clears on the reply, on a snapshot, and on a disconnect', () => {
    seedWindow()
    useChatStore.getState().requestOlder('chat-1')
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(true)
    // The reply clears it.
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a', events: [], hasOlder: true,
    })
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(false)
    // A reconnect snapshot clears it too.
    useChatStore.getState().requestOlder('chat-1')
    useChatStore.getState().snapshot(snapshotMessage({ historyHasOlder: true, historyStartId: 'hist-a' }))
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(false)
    // A dropped socket strands the claim: the disconnect sweep clears it.
    useChatStore.getState().requestOlder('chat-1')
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(true)
    useChatStore.getState().clearHistoryLoading()
    expect(useChatStore.getState().sessions['chat-1']!.historyLoading).toBe(false)
  })

  test('historyExpanded survives a reconnect snapshot within the page load', () => {
    seedWindow()
    useChatStore.getState().applyHistoryPage({
      type: 'chat-history-page', sessionId: 'chat-1', beforeId: 'hist-a', events: [replayed('hist-0', 'older')], hasOlder: true,
    })
    expect(useChatStore.getState().sessions['chat-1']!.historyExpanded).toBe(true)
    // The reconnect snapshot adopts the widened span, keeps the expansion.
    useChatStore.getState().snapshot(snapshotMessage({
      events: [replayed('hist-0', 'older'), delta(1, 'live')],
      throughSequence: 5, historyHasOlder: true, historyStartId: 'hist-0',
    }))
    const transcript = useChatStore.getState().sessions['chat-1']!
    expect(transcript.historyExpanded).toBe(true)
    expect(transcript.historyStartId).toBe('hist-0')
  })
})
