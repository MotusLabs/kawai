// Unit tests for the protocol message router: every server message type
// dispatches without throwing, and the ordering-sensitive behaviors
// (pendingKills epoch discard + rollback, pending-wake matching, worktree
// launch, transient errors) behave as they did inline in App.tsx.
import { beforeEach, describe, expect, test } from 'bun:test'
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
import { useChatStore } from '../stores/chatStore'

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
}

function makeDeps(): DepsHarness {
  const harness: DepsHarness = {
    transientErrors: [],
    cleared: 0,
    prefills: [],
    epoch: { value: 1 },
    deps: undefined as unknown as MessageRouterDeps,
  }
  const emptyRef = <T,>(): MutableRefObject<T> => ({ current: undefined as unknown as T })
  harness.deps = {
    getConnectionEpoch: () => harness.epoch.value,
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
      { type: 'chat-notifications', sessionId: 'chat-1', notifications: [] },
      { type: 'team-mailbox-snapshot', teamId: 'team', messages: [] },
      { type: 'team-tasks-snapshot', teamId: 'team', tasks: [] },
      { type: 'team-task-result', sessionId: 'chat-1', ok: true },
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
