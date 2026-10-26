// Contextual sends through the shared ChatSurface (plan-workspace §6.3–6.4,
// design D7): a workspace host's captured scope rides the additive
// `chat-send.workspaceContext` field, a host without a scope sends exactly as
// before, local reset commands never carry context, the transcript labels a
// message's stored context, and the full-screen wrapper wires the §6.4 seam
// so a reset there transfers repository bindings by the same CAS bind the
// embedded panel uses.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import type { WorkspaceContextVersion } from '@shared/planWorkspace'
import ChatSurface from '../components/chat/ChatSurface'
import ChatView from '../components/chat/ChatView'
import { pendingContextSends, type CapturedWorkspaceScope } from '../stores/planWorkspaceScopeStore'
import { useChatStore } from '../stores/chatStore'
import { useChatDebugStore } from '../stores/chatDebugStore'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { usePlanWorkspaceScopeStore } from '../stores/planWorkspaceScopeStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  useChatDebugStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
  pendingContextSends.clear()
})

const makeSession = (id: string, overrides: Partial<Session> = {}) =>
  ({
    id, name: id, projectPath: '/repo', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual', ...overrides,
  }) as unknown as Session

const version = (revision = 1): WorkspaceContextVersion =>
  ({ kind: 'revision', revision, contentHash: `hash-${revision}-0123456789` })

const scope = (revision = 1): CapturedWorkspaceScope => ({
  envelope: { teamId: 't', planId: 'p1', version: version(revision) },
  planTitle: 'Plan p1', capturedAt: '2026-10-24T09:00:00.000Z',
})

const userEvent = (id: string, text: string, context?: {
  teamId: string; planId: string; planTitle: string; version: WorkspaceContextVersion;
  executionId: string | null; changeName: string | null; documentRefId: string | null;
}) =>
  ({ id, sequence: 0, at: '2026-10-24T09:00:00.000Z', turnId: `t-${id}`, type: 'user_message' as const, text,
    ...(context ? { workspaceContext: context } : {}) })

type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
const snapshotMessage = (overrides: Partial<SnapshotMessage> = {}) =>
  ({
    type: 'chat-snapshot' as const, sessionId: 'chat-a', profileId: 'default', status: 'waiting' as const,
    throughSequence: 0, events: [], pendingRequests: [],
    commands: { status: 'unavailable' as const, commands: [] }, activity: null,
    contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    ...overrides,
  })

describe('ChatSurface contextual sends (§6.3)', () => {
  let sent: ClientMessage[]
  let listeners: Array<(message: ServerMessage) => void>
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => {
    sent = []
    listeners = []
  })

  const subscribe = (listener: (message: ServerMessage) => void) => {
    listeners.push(listener)
    return () => { listeners = listeners.filter(kept => kept !== listener) }
  }
  const deliver = (message: ServerMessage) => act(() => { for (const listener of listeners) listener(message) })
  const type = (value: string) =>
    act(() => { renderer!.root.findByType('textarea').props.onChange({ target: { value } }) })
  const submit = () =>
    act(() => { renderer!.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
  const chatSends = () => sent.filter(message => message.type === 'chat-send')

  test('a workspace host attaches the captured envelope; a host without a scope sends exactly as before', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage()) })
    act(() => {
      renderer = TestRenderer.create(<>
        <ChatSurface session={makeSession('chat-a')} sendMessage={message => { sent.push(message) }}
          connectionStatus="connected" connectionEpoch={1}
          onSubmitContext={() => scope(3)} />
        <ChatSurface session={makeSession('chat-b')} sendMessage={message => { sent.push(message) }}
          connectionStatus="connected" connectionEpoch={1} />
      </>)
    })
    renderers.push(renderer!)
    const inputs = renderer!.root.findAllByType('textarea')
    act(() => { inputs[0]!.props.onChange({ target: { value: 'scoped' } }) })
    act(() => { inputs[1]!.props.onChange({ target: { value: 'plain' } }) })
    const forms = renderer!.root.findAllByType('form')
    act(() => { forms[0]!.props.onSubmit({ preventDefault: () => {} }) })
    act(() => { forms[1]!.props.onSubmit({ preventDefault: () => {} }) })
    expect(chatSends()[0]).toEqual({
      type: 'chat-send', sessionId: 'chat-a', text: 'scoped',
      workspaceContext: { teamId: 't', planId: 'p1', version: version(3) },
      // Q2: a scoped send mints its correlation id; the refusal echo is
      // covered by the panel tests through the same path.
      requestId: expect.any(String),
    })
    expect(chatSends()[1]).toEqual({ type: 'chat-send', sessionId: 'chat-b', text: 'plain' })
  })

  test('local reset commands never carry context and leave no pending contextual send', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage()) })
    act(() => {
      renderer = TestRenderer.create(
        <ChatSurface session={makeSession('chat-a')} sendMessage={message => { sent.push(message) }}
          subscribe={subscribe} connectionStatus="connected" connectionEpoch={1}
          onSubmitContext={() => scope(1)} />)
    })
    renderers.push(renderer!)
    type('/reset')
    submit()
    expect(sent.filter(message => message.type === 'session-create')).toHaveLength(1)
    expect(sent.filter(message => message.type === 'chat-send')).toEqual([])
    expect(pendingContextSends.size).toBe(0)
  })

  test('the transcript labels a message stored with its validated context', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a',
        events: [userEvent('u1', 'what changed here', {
          teamId: 't', planId: 'p1', planTitle: 'Plan p1', version: version(1),
          executionId: 'e1', changeName: 'api', documentRefId: null,
        })],
      }))
    })
    act(() => {
      renderer = TestRenderer.create(
        <ChatSurface session={makeSession('chat-a')} sendMessage={message => { sent.push(message) }}
          connectionStatus="connected" connectionEpoch={1} />)
    })
    renderers.push(renderer!)
    const label = renderer!.root.findByProps({ 'data-testid': 'message-workspace-context' })
    const text = (label.children ?? []).join('')
    expect(text).toContain('Plan p1')
    expect(text).toContain('revision 1')
    expect(text).toContain('api')
  })
})

describe('full-screen reset transfer (§6.4)', () => {
  test('the full-screen ChatView transfers a repository binding on a local reset, by CAS', () => {
    act(() => {
      useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
      useTeamPlanWorkspaceStore.getState().applySnapshot({
        type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1',
        workspace: {
          plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' }, displayedVersion: null,
          bindings: [{ role: 'lead', sessionId: 'chat-a', version: 4, availability: 'live', name: 'chat-a' }],
          references: [],
        },
      })
    })
    act(() => { useChatStore.getState().snapshot(snapshotMessage()) })
    const sent: ClientMessage[] = []
    let listeners: Array<(message: ServerMessage) => void> = []
    const subscribe = (listener: (message: ServerMessage) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter(kept => kept !== listener) }
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={makeSession('chat-a')}
        sendMessage={message => { sent.push(message) }} subscribe={subscribe}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    renderers.push(renderer!)
    act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value: '/new fresh' } }) })
    act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    act(() => { for (const listener of listeners) listener({ type: 'session-created', session: {
      id: 'chat-new', name: 'fresh', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session }) })
    const bind = sent.find(message =>
      message.type === 'team-plan-workspace-bind' && message.sessionId === 'chat-new')
    expect(bind).toMatchObject({ teamPath: '/repo', role: 'lead', expectedVersion: 4 })
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-a' })
  })

  test('a reset of an unbound session transfers nothing', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage()) })
    const sent: ClientMessage[] = []
    let listeners: Array<(message: ServerMessage) => void> = []
    const subscribe = (listener: (message: ServerMessage) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter(kept => kept !== listener) }
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={makeSession('chat-a')}
        sendMessage={message => { sent.push(message) }} subscribe={subscribe}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    renderers.push(renderer!)
    act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value: '/clear' } }) })
    act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    act(() => { for (const listener of listeners) listener({ type: 'session-created', session: {
      id: 'chat-new', name: 'n', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session }) })
    expect(sent.filter(message => message.type === 'team-plan-workspace-bind')).toEqual([])
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-a' })
  })
})
