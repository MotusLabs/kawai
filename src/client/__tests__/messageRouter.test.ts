// Unit tests for the protocol message router: every server message type
// dispatches without throwing, and the ordering-sensitive behaviors
// (pendingKills epoch discard + rollback, pending-wake matching, worktree
// launch, transient errors) behave as they did inline in App.tsx.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { MutableRefObject } from 'react'
import type {
  AgentSession,
  HostStatus,
  ServerMessage,
  Session,
  TerminalSession,
  WorkspaceSnapshot,
} from '@shared/types'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps, SessionFormPrefill } from '../protocol/types'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTeamLocationStore } from '../hooks/useTeamLocation'
import { useChatStore } from '../stores/chatStore'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamMessageStore } from '../stores/teamMessageStore'
import type { ProductStrategy, StrategyDetail } from '@shared/productStrategy'
import type { TeamMessage } from '@shared/team'

const baseSession: TerminalSession = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

const baseAgentSession: AgentSession = {
  sessionId: 'agent-session-a',
  logFilePath: '/tmp/agent-a.jsonl',
  projectPath: '/tmp/alpha',
  agentType: 'claude',
  displayName: 'alpha',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: true,
  isPinned: false,
  lastUserMessage: undefined,
}

const initialSessionState = useSessionStore.getState()
const initialChatState = useChatStore.getState()

const hostStatus: HostStatus = { host: 'box', ok: true, lastUpdated: '2024-01-01T00:00:00.000Z' }

interface DepsHarness {
  deps: MessageRouterDeps
  transientErrors: string[]
  cleared: number
  prefills: SessionFormPrefill[]
  epoch: { value: number }
  sent: unknown[]
}

function makeDeps(): DepsHarness {
  const harness: DepsHarness = {
    transientErrors: [],
    cleared: 0,
    prefills: [],
    epoch: { value: 1 },
    sent: [],
    deps: undefined as unknown as MessageRouterDeps,
  }
  const emptyRef = <T,>(): MutableRefObject<T> => ({ current: undefined as unknown as T })
  harness.deps = {
    getConnectionEpoch: () => harness.epoch.value,
    sendClient: (message) => { harness.sent.push(message) },
    setTransientError: (message) => { harness.transientErrors.push(message) },
    clearTransientError: () => { harness.cleared += 1 },
    openSessionFormPrefilled: (prefill) => { harness.prefills.push(prefill) },
    setPendingHibernatingSession: () => {},
    pendingKills: { current: new Map() },
    pendingHibernateSelection: emptyRef(),
    pendingWakeSelection: emptyRef(),
    pendingWorktreeLaunch: emptyRef(),
    pendingChangeLaunch: emptyRef(),
  }
  return harness
}

beforeEach(() => {
  useSessionStore.setState(initialSessionState, true)
  useChatStore.setState(initialChatState, true)
  useStrategyStore.setState({ views: {} })
  useTeamMessageStore.setState({ views: {} })
})

describe('createMessageRouter dispatch coverage', () => {
  test('every router-handled server message type dispatches without throwing', () => {
    const { deps } = makeDeps()
    const route = createMessageRouter(deps)
    const messages: Array<ServerMessage | { type: string; [k: string]: unknown }> = [
      { type: 'terminal-output', sessionId: 'session-1', data: 'x', sequence: 0 },
      { type: 'sessions', sessions: [baseSession] },
      { type: 'session-update', session: { ...baseSession, status: 'waiting' } },
      { type: 'session-created', session: baseSession },
      { type: 'session-removed', sessionId: 'session-1' },
      { type: 'session-orphaned', session: baseAgentSession, supersededBy: null },
      { type: 'session-activated', session: baseAgentSession, window: 'agentboard:1' },
      { type: 'session-wake-result', sessionId: 'agent-session-a', ok: true, session: baseSession },
      { type: 'session-wake-result', sessionId: 'agent-session-a', ok: false, error: { code: 'E_FAIL', message: 'nope' } },
      { type: 'session-hibernate-result', sessionId: 'agent-session-a', ok: true, session: baseAgentSession },
      { type: 'session-hibernate-result', sessionId: 'agent-session-a', ok: false, error: 'nope' },
      { type: 'session-move-to-history-result', ok: true },
      { type: 'session-move-to-history-result', ok: false, error: 'nope' },
      { type: 'kill-failed', sessionId: 'session-1', message: 'kill refused' },
      { type: 'agent-sessions', active: [], hibernating: [baseAgentSession], history: [] },
      { type: 'agent-sessions-active', active: [] },
      { type: 'workspace-snapshot', snapshot: { repositories: [] } as unknown as WorkspaceSnapshot },
      { type: 'workspace-operation-result', result: { operation: 'create-worktree', ok: true, repositoryId: 'r', branch: 'b', path: '/tmp/wt' } },
      { type: 'workspace-operation-result', result: { operation: 'create-worktree', ok: false, error: 'boom' } },
      { type: 'workspace-operation-result', result: { operation: 'create-change-worktree', ok: true, repositoryId: 'r', change: 'c', branch: 'b', path: '/tmp/wt', commit: 'abc', gitignoreUpdated: false } },
      { type: 'workspace-operation-result', result: { operation: 'create-change-worktree', ok: false, error: 'boom' } },
      { type: 'host-status', hosts: [hostStatus] },
      { type: 'server-config', remoteAllowControl: false, remoteAllowAttach: false, hostLabel: null, preferWindowName: false },
      { type: 'update-state', update: { current: '1.0.0', target: null } },
      { type: 'error', message: 'server says no' },
      { type: 'terminal-error', sessionId: null, code: 'ERR_TMUX_ATTACH_FAILED', message: 'gone', retryable: false },
      { type: 'terminal-ready', sessionId: 'session-1' },
      { type: 'chat-events', sessionId: 'chat-1', events: [] },
      { type: 'chat-commands', sessionId: 'chat-1', state: { status: 'ready', commands: [] } },
      { type: 'chat-activity', sessionId: 'chat-1', activity: null },
      { type: 'chat-context-usage', sessionId: 'chat-1', usage: null },
      { type: 'chat-usage', profileId: 'default', report: null },
      { type: 'chat-workers', sessionId: 'chat-1', workers: [] },
      { type: 'chat-model', sessionId: 'chat-1', model: 'claude-sonnet-5-5' },
      { type: 'chat-notifications', sessionId: 'chat-1', notifications: [] },
      { type: 'team-mailbox-snapshot', teamId: 'team', messages: [] },
      { type: 'team-mailbox-delivered-to-human', teamId: 'team', messageId: 'm-1', senderSession: 'chat-2', senderKind: 'agent' },
      { type: 'team-tasks-snapshot', teamId: 'team', tasks: [] },
      { type: 'team-task-result', teamPath: 'chat-1', ok: true },
      { type: 'team-messages-snapshot', teamPath: 'chat-1', teamId: 'team', filters: {}, messages: [], nextCursor: null, threadSizes: {}, directory: [], tasks: [] },
      { type: 'team-messages', teamPath: 'chat-1', teamId: 'team', messages: [] },
      { type: 'team-thread', teamPath: 'chat-1', teamId: 'team', threadId: 't-1', entries: [], directory: [] },
      { type: 'team-message-send-result', teamPath: 'chat-1', requestId: 'r-1', error: 'nope' },
    ]
    for (const message of messages) {
      expect(() => route(message as ServerMessage)).not.toThrow()
    }
  })

  test('host-status lands in the session store', () => {
    const route = createMessageRouter(makeDeps().deps)
    route({ type: 'host-status', hosts: [hostStatus] })
    expect(useSessionStore.getState().hostStatuses).toEqual([hostStatus])
  })

  test('chat-commands lands in the chat store', () => {
    const route = createMessageRouter(makeDeps().deps)
    route({ type: 'chat-commands', sessionId: 'chat-1', state: { status: 'ready', commands: [] } })
    expect(useChatStore.getState().sessions['chat-1']?.commands).toEqual({ status: 'ready', commands: [] })
  })
})

describe('pending kill lifecycle', () => {
  test('a sessions snapshot discards pending kills from a previous epoch and filters current ones', () => {
    const harness = makeDeps()
    harness.deps.pendingKills.current.set('session-1', { session: baseSession, wasSelected: true, epoch: 0 })
    harness.deps.pendingKills.current.set('session-2', { session: { ...baseSession, id: 'session-2' }, wasSelected: false, epoch: 1 })
    const route = createMessageRouter(harness.deps)

    route({ type: 'sessions', sessions: [baseSession, { ...baseSession, id: 'session-2' }] })

    // The stale-epoch entry (session-1) is DISCARDED from the map before the
    // filter runs, so the reconnect snapshot is authoritative for it (kept —
    // the old connection's kill no longer applies); the current-epoch entry
    // (session-2) persists and still filters its session out.
    const state = useSessionStore.getState()
    expect(state.sessions.map((s: Session) => s.id)).toEqual(['session-1'])
    expect(harness.deps.pendingKills.current.has('session-1')).toBe(false)
    expect(harness.deps.pendingKills.current.has('session-2')).toBe(true)
  })

  test('kill-failed restores the snapshot and selection, then clears the entry', () => {
    const harness = makeDeps()
    harness.deps.pendingKills.current.set('session-1', { session: baseSession, wasSelected: true, epoch: 1 })
    const route = createMessageRouter(harness.deps)

    route({ type: 'kill-failed', sessionId: 'session-1', message: 'kill refused' })

    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['session-1'])
    expect(state.selectedSessionId).toBe('session-1')
    expect(harness.deps.pendingKills.current.has('session-1')).toBe(false)
    expect(harness.transientErrors).toEqual(['kill refused'])
  })
})

describe('pending wake matching', () => {
  test('a sessions snapshot selects the session matching the pending wake id', () => {
    const harness = makeDeps()
    harness.deps.pendingWakeSelection.current = 'agent-session-a'
    const route = createMessageRouter(harness.deps)

    route({
      type: 'sessions',
      sessions: [{ ...baseSession, agentSessionId: 'agent-session-a' }],
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
    expect(harness.deps.pendingWakeSelection.current).toBeNull()
  })

  test('no match keeps the pending id for the next snapshot', () => {
    const harness = makeDeps()
    harness.deps.pendingWakeSelection.current = 'agent-session-zz'
    const route = createMessageRouter(harness.deps)

    route({ type: 'sessions', sessions: [baseSession] })

    expect(useSessionStore.getState().selectedSessionId).toBeNull()
    expect(harness.deps.pendingWakeSelection.current).toBe('agent-session-zz')
  })
})

describe('worktree launches and transient errors', () => {
  test('a matched create-worktree result opens the prefilled session form', () => {
    const harness = makeDeps()
    harness.deps.pendingWorktreeLaunch.current = { repositoryId: 'r', branch: 'b' }
    const route = createMessageRouter(harness.deps)

    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: true, repositoryId: 'r', branch: 'b', path: '/tmp/wt' },
    })

    expect(harness.prefills).toEqual([{ host: undefined, path: '/tmp/wt', command: undefined, autoStartChange: undefined }])
    expect(harness.deps.pendingWorktreeLaunch.current).toBeNull()
  })

  test('an UNMATCHED successful create-worktree result keeps the pending launch intact', () => {
    const harness = makeDeps()
    harness.deps.pendingWorktreeLaunch.current = { repositoryId: 'r', branch: 'b' }
    const route = createMessageRouter(harness.deps)

    // A different client's worktree (or a second creation in flight)
    // succeeds first — it must not consume our pending launch.
    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: true, repositoryId: 'other', branch: 'zz', path: '/tmp/other' },
    })

    expect(harness.prefills).toEqual([])
    expect(harness.transientErrors).toEqual([])
    expect(harness.deps.pendingWorktreeLaunch.current).toEqual({ repositoryId: 'r', branch: 'b' })

    // The matching result arriving afterwards still opens the form.
    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: true, repositoryId: 'r', branch: 'b', path: '/tmp/wt' },
    })
    expect(harness.prefills).toEqual([{ host: undefined, path: '/tmp/wt', command: undefined, autoStartChange: undefined }])
    expect(harness.deps.pendingWorktreeLaunch.current).toBeNull()
  })

  test('an unmatched successful create-change-worktree result keeps its pending launch intact', () => {
    const harness = makeDeps()
    harness.deps.pendingChangeLaunch.current = { repositoryId: 'r', change: 'c' }
    const route = createMessageRouter(harness.deps)

    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-change-worktree', ok: true, repositoryId: 'other', change: 'zz', branch: 'b', path: '/tmp/other', commit: 'x', gitignoreUpdated: false },
    })

    expect(harness.prefills).toEqual([])
    expect(harness.deps.pendingChangeLaunch.current).toEqual({ repositoryId: 'r', change: 'c' })

    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-change-worktree', ok: true, repositoryId: 'r', change: 'c', branch: 'b', path: '/tmp/wt', commit: 'x', gitignoreUpdated: false },
    })
    expect(harness.prefills).toEqual([{ host: undefined, path: '/tmp/wt', command: undefined, autoStartChange: 'c' }])
    expect(harness.deps.pendingChangeLaunch.current).toBeNull()
  })

  test('a failed create-worktree result surfaces the error and clears the pending launch', () => {
    const harness = makeDeps()
    harness.deps.pendingWorktreeLaunch.current = { repositoryId: 'r', branch: 'b' }
    const route = createMessageRouter(harness.deps)

    route({
      type: 'workspace-operation-result',
      result: { operation: 'create-worktree', ok: false, error: 'branch missing' },
    })

    expect(harness.transientErrors).toEqual(['branch missing'])
    expect(harness.deps.pendingWorktreeLaunch.current).toBeNull()
    expect(harness.prefills).toEqual([])
  })

  test('terminal-error for the selected session shows the banner; terminal-ready clears it', () => {
    const harness = makeDeps()
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    const route = createMessageRouter(harness.deps)

    route({ type: 'terminal-error', sessionId: 'session-1', code: 'ERR_TMUX_ATTACH_FAILED', message: 'gone', retryable: false })
    expect(harness.transientErrors).toEqual(['ERR_TMUX_ATTACH_FAILED: gone'])

    route({ type: 'terminal-ready', sessionId: 'session-1' })
    expect(harness.cleared).toBe(1)
  })
})


describe('product strategy routing after extraction', () => {
  test('snapshots and detail populate an open view, and refusals settle pending actions', () => {
    const route = createMessageRouter(makeDeps().deps)
    const strategy: ProductStrategy = {
      id: 'strategy-1', productId: 'kawai', title: 'Kawai',
      owner: { kind: 'human', sessionId: null }, lifecycle: 'active',
      currentApprovedRevision: null, repoBindings: [], createdAt: '', updatedAt: '',
    }
    const detail: StrategyDetail = {
      strategy, revisions: [], drafts: [], evidence: [], decisions: [], impactReviews: [],
    }
    useStrategyStore.getState().open('chat-1')
    route({ type: 'strategy-snapshot', teamPath: 'chat-1', teamId: 'team', strategy })
    route({ type: 'strategy-detail', teamPath: 'chat-1', teamId: 'team', detail })
    expect(useStrategyStore.getState().views['chat-1']).toMatchObject({
      seen: true, loading: false, strategy, detail,
    })
    useStrategyStore.getState().begin('chat-1', 'save-1', 'save')
    route({ type: 'strategy-result', teamPath: 'chat-1', requestId: 'save-1', error: 'Draft changed' })
    expect(useStrategyStore.getState().views['chat-1']).toMatchObject({
      pending: {}, error: 'Draft changed',
    })
    useStrategyStore.getState().close('chat-1')
    route({ type: 'strategy-snapshot', teamPath: 'chat-1', teamId: 'team', strategy })
    expect(useStrategyStore.getState().views['chat-1']).toBeUndefined()
  })
})

describe('team messages routing after extraction', () => {
  const row = (id: string): TeamMessage => ({
    id, teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent',
    fromSession: 'chat-2', fromGroup: 'leads', originPath: '/tmp',
    priority: 'normal', tags: [], threadId: 't-1', inReplyTo: null, hop: 1,
    body: 'hello', state: 'delivered', claimedBy: null, claimedAt: null,
    deliverAt: null, createdAt: '2024-01-01T00:00:00.000Z', pushedAt: null,
    deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false,
    taskId: null, taskRevision: null, claimCommit: null, parkedUntil: null,
    parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
  })

  test('a snapshot opens the view, pushes and threads fold in, and a result settles the composer', () => {
    const route = createMessageRouter(makeDeps().deps)
    useTeamMessageStore.getState().open('chat-1')
    route({
      type: 'team-messages-snapshot', teamPath: 'chat-1', teamId: 'team', filters: {},
      messages: [row('m-1')], nextCursor: null,
      directory: [{ sessionId: 'chat-2', name: 'Dev', group: 'leads' }], tasks: [], threadSizes: {},
    })
    expect(useTeamMessageStore.getState().views['chat-1']).toMatchObject({
      open: true, loading: false, teamId: 'team', nextCursor: null,
    })
    expect(useTeamMessageStore.getState().views['chat-1']!.messages.map(m => m.id)).toEqual(['m-1'])
    expect(useTeamMessageStore.getState().views['chat-1']!.directory).toEqual([
      { sessionId: 'chat-2', name: 'Dev', group: 'leads' },
    ])

    route({ type: 'team-messages', teamPath: 'chat-1', teamId: 'team', messages: [row('m-2')], directory: [] })
    expect(useTeamMessageStore.getState().views['chat-1']!.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])

    // A thread reply only folds into the thread the view has open (replace
    // semantics) — select first, as TeamMessagesView does.
    useTeamMessageStore.getState().select('chat-1', 't-1')
    route({
      type: 'team-thread', teamPath: 'chat-1', teamId: 'team', threadId: 't-1',
      entries: [{ message: row('m-1'), events: [] }], directory: [],
    })
    expect(useTeamMessageStore.getState().views['chat-1']!.selectedThreadId).toBe('t-1')
    expect(useTeamMessageStore.getState().views['chat-1']!.thread).toHaveLength(1)

    useTeamMessageStore.getState().beginSend('chat-1', 'r-1')
    expect(useTeamMessageStore.getState().views['chat-1']!.pending['r-1']).toBe('send')
    route({ type: 'team-message-send-result', teamPath: 'chat-1', requestId: 'r-1', error: 'nope' })
    expect(useTeamMessageStore.getState().views['chat-1']!.pending).toEqual({})
    expect(useTeamMessageStore.getState().views['chat-1']!.error).toBe('nope')

    useTeamMessageStore.getState().close('chat-1')
    route({ type: 'team-messages-snapshot', teamPath: 'chat-1', teamId: 'team', filters: {}, messages: [], nextCursor: null, threadSizes: {}, directory: [], tasks: [] })
    expect(useTeamMessageStore.getState().views['chat-1']).toBeUndefined()
  })
})

describe('status transition sounds', () => {
  // Minimal Web Audio stub: sound.ts only needs enough to build the tone
  // graph, and counting createOscillator calls proves a sound played (the
  // idle chime creates exactly two oscillators, 440Hz + 550Hz).
  let oscillatorCount = 0
  // Seed the mocked clock far above any real timestamp: sound.ts's
  // module-level lastPlayTime survives across files in the shared runner
  // process, and a real stamp from an earlier file would mute these chimes.
  const realDateNow = Date.now
  let nowMs = realDateNow() + 1_000_000_000
  // This file shares a process with every other non-isolated client test, so
  // the window/document stubs must be restored or they leak into later files
  // (the known motion-frame-callback leak class in scripts/test-runner.ts).
  const realWindow = (globalThis as Record<string, unknown>).window
  const realDocument = (globalThis as Record<string, unknown>).document

  class FakeAudioContext {
    state = 'running'
    currentTime = 0
    destination = {}
    resume = async () => {}
    createGain = () => ({
      connect: () => {},
      gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
    })
    createOscillator = () => {
      oscillatorCount += 1
      return {
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        frequency: { setValueAtTime: () => {} },
      }
    }
  }

  // The sound path is async (playTone awaits before creating oscillators),
  // so each test yields one macrotask before counting.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const routeSessionUpdate = (session: TerminalSession) => {
    const route = createMessageRouter(makeDeps().deps)
    route({ type: 'session-update', session })
  }

  const routeSessions = (sessions: TerminalSession[]) => {
    const route = createMessageRouter(makeDeps().deps)
    route({ type: 'sessions', sessions })
  }

  beforeEach(() => {
    oscillatorCount = 0
    // Keep the mocked clock monotonic across tests — the sound module's
    // 500 ms rate limit mutes a chime if Date.now() moves backwards.
    nowMs += 1_000
    Date.now = () => nowMs
    ;(globalThis as Record<string, unknown>).window = { AudioContext: FakeAudioContext }
    ;(globalThis as Record<string, unknown>).document = { visibilityState: 'visible' }
    useSettingsStore.setState({ soundOnPermission: true, soundOnIdle: true })
    useTeamLocationStore.setState({ location: null })
    useSessionStore.setState({
      sessions: [
        baseSession,
        { ...baseSession, id: 'session-2', name: 'beta', tmuxWindow: 'agentboard:2' },
      ],
    })
  })

  afterEach(() => {
    Date.now = realDateNow
    const globals = globalThis as Record<string, unknown>
    if (realWindow === undefined) delete globals.window
    else globals.window = realWindow
    if (realDocument === undefined) delete globals.document
    else globals.document = realDocument
    useSettingsStore.setState({ soundOnPermission: false, soundOnIdle: false })
  })

  test('a selected, visible session-update plays no idle sound', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    nowMs += 1_000
    routeSessionUpdate({ ...baseSession, status: 'waiting' })
    await flush()
    expect(oscillatorCount).toBe(0)
  })

  test('a sessions list moving only the selected session to waiting plays no idle sound', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    nowMs += 1_000
    routeSessions([{ ...baseSession, status: 'waiting' }])
    await flush()
    expect(oscillatorCount).toBe(0)
  })

  test('a background session entering permission plays the permission sound', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    nowMs += 1_000
    routeSessionUpdate({ ...baseSession, id: 'session-2', name: 'beta', tmuxWindow: 'agentboard:2', status: 'permission' })
    await flush()
    // The permission ping is a single oscillator (880Hz).
    expect(oscillatorCount).toBe(1)
  })

  test('a non-selected session-update plays the idle chime', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-2' })
    nowMs += 1_000
    routeSessionUpdate({ ...baseSession, status: 'waiting' })
    await flush()
    expect(oscillatorCount).toBe(2)
  })

  test('a sessions list moving a selected and a background session to waiting plays exactly one chime', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    nowMs += 1_000
    routeSessions([
      { ...baseSession, status: 'waiting' },
      { ...baseSession, id: 'session-2', name: 'beta', tmuxWindow: 'agentboard:2', status: 'waiting' },
    ])
    await flush()
    expect(oscillatorCount).toBe(2)
  })

  test('a selected session finishing with the Team page open plays the idle chime', async () => {
    useSessionStore.setState({ selectedSessionId: 'session-1' })
    useTeamLocationStore.setState({ location: { teamKey: 'k', tab: 'tasks' } as never })
    nowMs += 1_000
    routeSessionUpdate({ ...baseSession, status: 'waiting' })
    await flush()
    expect(oscillatorCount).toBe(2)
  })
})
