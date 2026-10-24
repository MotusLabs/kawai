// The repository conversation panel (plan-workspace §6.2–6.4): binding is an
// explicit human act over same-team ordinary chats (never the other role's
// session), a bind refusal surfaces inline, create-then-bind binds only an
// observed same-team creation and one creation discharges the arm, exactly
// one role's surface is mounted (only the selected role attaches), the Lead
// line warns on an execution leadGroup mismatch without granting authority,
// an embedded reset transfers the binding by CAS, and the panel alone starts
// no worker. The captured scope (§6.3) is covered with it: capture on the
// first nonempty draft, navigation never mutates a nonempty draft's capture,
// a mismatch is explained and replaced only explicitly, and the empty state
// sends unscoped.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ComponentProps } from 'react'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import type { WorkspaceRepository, WorkspaceSnapshot as ClientWorkspaceSnapshot } from '@shared/workspace'
import type { WorkspaceBindingView, WorkspaceSnapshot } from '@shared/planWorkspace'
import { normalizePlanContent, type PlanRevision } from '@shared/plans'
import PlanWorkspaceConversation from '../components/team/PlanWorkspaceConversation'
import { planDetail, planSummary } from './planViewFixtures'
import { useChatStore } from '../stores/chatStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { pendingContextSends, usePlanWorkspaceScopeStore } from '../stores/planWorkspaceScopeStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  useWorkspaceStore.setState({ snapshot: null })
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
  pendingContextSends.clear()
})

const makeSession = (id: string, overrides: Partial<Session> = {}) =>
  ({
    id, name: id, projectPath: '/repo', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual', ...overrides,
  }) as unknown as Session

const repository = (): WorkspaceRepository => ({
  id: 'r1', name: 'repo', commonDir: '/repo/.git',
  worktrees: [{
    id: '/repo', repositoryId: 'r1', path: '/repo', headRevision: 'a'.repeat(40),
    detached: false, isMain: true, dirty: false, openspec: { changes: [], stale: false },
  }],
  branches: [], stale: false,
})

const seedRepositories = () => act(() => {
  useWorkspaceStore.setState({ snapshot: { repositories: [repository()], generatedAt: '2026-10-24T09:00:00.000Z' } as ClientWorkspaceSnapshot })
})

const binding = (role: 'architect' | 'lead', sessionId: string, version: number,
  availability: WorkspaceBindingView['availability'] = 'live'): WorkspaceBindingView =>
  ({ role, sessionId, version, availability, name: sessionId })

const workspaceSnapshot = (bindings: WorkspaceBindingView[]): WorkspaceSnapshot => ({
  plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' },
  displayedVersion: { kind: 'revision', revision: 1, status: 'approved', contentHash: 'hash-1-0123456789' },
  bindings, references: [],
})

const revision = (leadGroup?: string): PlanRevision => ({
  revision: 1, status: 'approved',
  content: normalizePlanContent(leadGroup ? { goal: 'Ship', leadGroup } : { goal: 'Ship' }),
  contentHash: 'hash-1-0123456789', pin: null, author: { kind: 'agent', sessionId: 'lead' },
  createdAt: '2026-10-20T00:00:00.000Z',
})

const selectionWith = (bindings: WorkspaceBindingView[], leadGroup?: string) => ({
  detail: planDetail(planSummary('p1', { currentApprovedRevision: 1, state: 'in-progress' }),
    { revisions: [revision(leadGroup)] }),
  snapshot: workspaceSnapshot(bindings), teamId: 't',
  version: null, executionId: null, selectedChange: null, selectedDocument: null,
})

type PanelProps = ComponentProps<typeof PlanWorkspaceConversation>

const mountPanel = (overrides: Partial<PanelProps> = {}) => {
  const sent: ClientMessage[] = []
  let listeners: Array<(message: ServerMessage) => void> = []
  const subscribe = (listener: (message: ServerMessage) => void) => {
    listeners.push(listener)
    return () => { listeners = listeners.filter(kept => kept !== listener) }
  }
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const base: PanelProps = {
    teamPath: '/repo', sessions: [],
    connected: true, connectionEpoch: 1, sendMessage, subscribe, selection: null,
  }
  const element = (extra: Partial<PanelProps> = {}) =>
    <PlanWorkspaceConversation {...base} {...overrides} {...extra} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element()) })
  renderers.push(renderer)
  const deliver = (message: ServerMessage) =>
    act(() => { for (const listener of [...listeners]) listener(message) })
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
    typeof node === 'string' ? node : node.children.map(textOf).join('')
  /** The picker's selectable option values, in render order. */
  const pickerOptions = (testId = 'conversation-bind-picker') =>
    ([byId(testId).props.children].flat(3) as Array<{ props: { value: string } }>).filter(Boolean)
      .map(option => option.props.value)
  return { sent, renderer, element, deliver, byId, has, textOf, pickerOptions,
    rerender: (extra: Partial<PanelProps> = {}) => act(() => renderer.update(element(extra))) }
}

type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
const snapshotMessage = (overrides: Partial<SnapshotMessage> = {}) =>
  ({
    type: 'chat-snapshot' as const, sessionId: 's-old', profileId: 'default', status: 'waiting' as const,
    throughSequence: 0, events: [], pendingRequests: [],
    commands: { status: 'unavailable' as const, commands: [] }, activity: null,
    contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    ...overrides,
  })

/** Seeds the team bindings slot (Q1) the way the server's bindings push does. */
const seedBindings = (teamPath: string, bindings: WorkspaceBindingView[]) => act(() => {
  useTeamPlanWorkspaceStore.getState().applyBindings({
    type: 'team-plan-workspace-bindings', teamPath, teamId: 't', bindings,
  })
})

/** The requestId the surface minted for its contextual chat-send, if any. */
const sentRequestId = (panel: ReturnType<typeof mountPanel>): string | undefined => {
  const send = panel.sent.find(message => message.type === 'chat-send') as
    | { requestId?: string } | undefined
  return send?.requestId
}

/** The requestId of the panel's Nth (0-based) contextual chat-send. */
const sentRequestAt = (panel: ReturnType<typeof mountPanel>, index: number): string => {
  const send = panel.sent.filter(message => message.type === 'chat-send')[index] as
    | { requestId?: string } | undefined
  if (!send?.requestId) throw new Error(`no chat-send #${index} carried a requestId`)
  return send.requestId
}

describe('PlanWorkspaceConversation binding (§6.2)', () => {
  beforeEach(() => { seedRepositories() })

  test('an unbound role offers same-team ordinary chats only; picking one binds it (first bind, no CAS token)', () => {
    const panel = mountPanel({
      sessions: [makeSession('s-a'), makeSession('s-b', { projectPath: '/elsewhere' }),
        makeSession('s-term', { kind: 'terminal' })],
    })
    expect(panel.has('conversation-unbound-architect')).toBe(true)
    // Same-team ordinary chats only: the other team's chat and the terminal are not offered.
    expect(panel.pickerOptions()).toEqual(['', 's-a'])
    panel.byId('conversation-bind-picker').props.onChange({ target: { value: 's-a' } })
    const bind = panel.sent.find(message => message.type === 'team-plan-workspace-bind')
    expect(bind).toMatchObject({ teamPath: '/repo', role: 'architect', sessionId: 's-a', expectedVersion: null })
  })

  test('the other role session and the bound session itself are never offered for replacement; the replace binds by CAS', () => {
    seedBindings('/repo', [binding('architect', 's-a', 3), binding('lead', 's-lead', 1)])
    const panel = mountPanel({
      sessions: [makeSession('s-a'), makeSession('s-lead'), makeSession('s-c')],
      selection: selectionWith([binding('architect', 's-a', 3), binding('lead', 's-lead', 1)]),
    })
    expect(panel.has('conversation-binding-architect')).toBe(true)
    // The architect picker offers only s-c: not the bound session, not the Lead's.
    expect(panel.pickerOptions()).toEqual(['', 's-c'])
    panel.byId('conversation-bind-picker').props.onChange({ target: { value: 's-c' } })
    const bind = panel.sent.find(message => message.type === 'team-plan-workspace-bind')
    expect(bind).toMatchObject({ role: 'architect', sessionId: 's-c', expectedVersion: 3 })
  })

  test('a refused bind surfaces inline; the line names availability for archived and unavailable bindings', () => {
    const panel = mountPanel({
      sessions: [makeSession('s-a')],
    })
    panel.byId('conversation-bind-picker').props.onChange({ target: { value: 's-a' } })
    const bind = panel.sent.find(message => message.type === 'team-plan-workspace-bind')!
    panel.deliver({ type: 'team-plan-workspace-result', teamPath: '/repo', requestId: bind.requestId,
      error: 'Session is bound to another role.' })
    expect(panel.textOf(panel.byId('conversation-bind-error'))).toContain('another role')
    // Archived/unavailable bindings name their state on the binding line
    // (a bindings push, not a prop, carries the availability).
    seedBindings('/repo', [binding('architect', 's-a', 1, 'archived')])
    panel.rerender({ sessions: [makeSession('s-a', { archivedAt: '2026-10-24T08:00:00.000Z' })] })
    expect(panel.has('conversation-unbound-architect')).toBe(false)
    expect(panel.textOf(panel.byId('conversation-binding-line-architect'))).toContain('read-only until restore')
  })

  test('create-then-bind binds only an observed same-team chat; any creation discharges the arm; an error disarms', () => {
    const panel = mountPanel({ sessions: [], onOpenNewSession: () => {} })
    panel.byId('conversation-new-chat-architect').props.onClick()
    // An other-team creation is never bound — and it still discharges the arm.
    panel.deliver({ type: 'session-created', session: {
      id: 's-x', name: 'x', kind: 'chat', projectPath: '/elsewhere',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session })
    expect(panel.sent.filter(message => message.type === 'team-plan-workspace-bind')).toEqual([])
    // Re-arm: a same-team creation binds with the created id.
    panel.byId('conversation-new-chat-architect').props.onClick()
    panel.deliver({ type: 'session-created', session: {
      id: 's-new', name: 'n', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session })
    const bind = panel.sent.find(message => message.type === 'team-plan-workspace-bind')
    expect(bind).toMatchObject({ role: 'architect', sessionId: 's-new', expectedVersion: null })
    // A later, unrelated creation binds nothing.
    const after = panel.sent.length
    panel.deliver({ type: 'session-created', session: {
      id: 's-late', name: 'l', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session })
    expect(panel.sent.length).toBe(after)
  })

  test('a creation error disarms create-then-bind: nothing binds afterwards', () => {
    const panel = mountPanel({ sessions: [], onOpenNewSession: () => {} })
    panel.byId('conversation-new-chat-architect').props.onClick()
    panel.deliver({ type: 'error', message: 'Claude Agent SDK is unavailable.' })
    panel.deliver({ type: 'session-created', session: {
      id: 's-late', name: 'l', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session })
    expect(panel.sent.filter(message => message.type === 'team-plan-workspace-bind')).toEqual([])
  })

  test('exactly one conversation attaches: the selected role only; switching roles swaps the surface', () => {
    seedBindings('/repo', [binding('architect', 's-a', 1), binding('lead', 's-b', 1)])
    const panel = mountPanel({
      sessions: [makeSession('s-a'), makeSession('s-b')],
    })
    const attachOf = () => panel.sent.filter(message => message.type === 'chat-attach')
      .map(message => message.sessionId)
    expect(attachOf()).toEqual(['s-a'])
    expect(panel.renderer.root.findAllByType('textarea')).toHaveLength(1)
    act(() => { panel.byId('conversation-role-lead').props.onClick() })
    expect(attachOf()).toEqual(['s-a', 's-b'])
    expect(panel.renderer.root.findAllByType('textarea')).toHaveLength(1)
    // No worker, session, or task machinery is ever started by mounting or
    // switching: the only non-chat messages are the bind family and the
    // panel's own lazy bindings subscription (Q1, open on mount only).
    for (const message of panel.sent) {
      expect(['chat-attach', 'chat-detach', 'team-plan-workspace-bind',
        'team-plan-workspace-bindings-open']).toContain(message.type)
    }
    expect(panel.sent.filter(message => message.type === 'team-plan-workspace-bindings-open'))
      .toEqual([{ type: 'team-plan-workspace-bindings-open', teamPath: '/repo' }])
  })

  test('the Lead line warns when the plan execution leadGroup differs from the bound chat group; no authority is granted', () => {
    const bindings = [binding('architect', 's-a', 1), binding('lead', 's-lead', 1)]
    seedBindings('/repo', bindings)
    const sessions = [makeSession('s-a'), makeSession('s-lead', { groupId: 'middle-devs', groupLabel: 'Middle Dev' })]
    const panel = mountPanel({ sessions, selection: selectionWith(bindings, 'change-leads') })
    act(() => { panel.byId('conversation-role-lead').props.onClick() })
    const warning = panel.textOf(panel.byId('conversation-lead-mismatch'))
    expect(warning).toContain('change-leads')
    expect(warning).toContain('grants no authority')
    // A matching group (or an Architect tab) shows no warning.
    panel.rerender({ sessions: [makeSession('s-a'), makeSession('s-lead', { groupId: 'change-leads' })] })
    expect(panel.has('conversation-lead-mismatch')).toBe(false)
    panel.rerender({ sessions })
    act(() => { panel.byId('conversation-role-architect').props.onClick() })
    expect(panel.has('conversation-lead-mismatch')).toBe(false)
  })

  test('an embedded local reset transfers the binding by the same CAS bind, exactly once, leaving the other role untouched', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2), binding('lead', 's-lead', 1)])
    act(() => {
      useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
      useTeamPlanWorkspaceStore.getState().applySnapshot({
        type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1',
        workspace: workspaceSnapshot([binding('architect', 's-old', 2), binding('lead', 's-lead', 1)]),
      })
    })
    act(() => { useChatStore.getState().snapshot(snapshotMessage({ sessionId: 's-old' })) })
    const panel = mountPanel({
      sessions: [makeSession('s-old'), makeSession('s-lead')],
    })
    act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value: '/clear' } }) })
    act(() => { panel.renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    panel.deliver({ type: 'session-created', session: {
      id: 's-new', name: 'n', kind: 'chat', projectPath: '/repo',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session })
    // The §6.4 transfer used the last observed version, and the old chat archived.
    const bind = panel.sent.find(message =>
      message.type === 'team-plan-workspace-bind' && message.sessionId === 's-new')
    expect(bind).toMatchObject({ teamPath: '/repo', role: 'architect', expectedVersion: 2 })
    expect(panel.sent).toContainEqual({ type: 'chat-archive', sessionId: 's-old' })
    expect(panel.sent.filter(message =>
      message.type === 'team-plan-workspace-bind' && message.role === 'architect')).toHaveLength(1)
    // The other role's binding (s-lead) is never rebound (§6.4).
    expect(panel.sent.filter(message =>
      message.type === 'team-plan-workspace-bind' && message.role === 'lead')).toHaveLength(0)
  })

  test('switching roles restores each session draft; neither role starts the other agent', () => {
    seedBindings('/repo', [binding('architect', 's-a', 1), binding('lead', 's-b', 1)])
    const panel = mountPanel({
      sessions: [makeSession('s-a'), makeSession('s-b')],
    })
    act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value: 'architect thought' } }) })
    act(() => { panel.byId('conversation-role-lead').props.onClick() })
    act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value: 'lead note' } }) })
    expect(useChatStore.getState().drafts['s-b']).toBe('lead note')
    act(() => { panel.byId('conversation-role-architect').props.onClick() })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('architect thought')
  })
})

describe('PlanWorkspaceConversation captured scope (§6.3)', () => {
  beforeEach(() => {
    seedRepositories()
    act(() => { useChatStore.getState().snapshot(snapshotMessage({ sessionId: 's-a' })) })
  })

  const boundPanel = () => {
    seedBindings('/repo', [binding('architect', 's-a', 1)])
    return mountPanel({
      sessions: [makeSession('s-a')],
      selection: selectionWith([binding('architect', 's-a', 1)]),
    })
  }
  const type = (panel: ReturnType<typeof boundPanel>, value: string) =>
    act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value } }) })
  const submit = (panel: ReturnType<typeof boundPanel>) =>
    act(() => { panel.renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
  const sends = (panel: ReturnType<typeof boundPanel>) =>
    panel.sent.filter(message => message.type === 'chat-send')

  test('the empty state sends unscoped and says so; a scoped draft attaches its envelope to the send', () => {
    seedBindings('/repo', [binding('architect', 's-a', 1)])
    const unscoped = mountPanel({ sessions: [makeSession('s-a')] })
    expect(unscoped.has('composer-scope-unscoped')).toBe(true)
    type(unscoped, 'hello')
    submit(unscoped)
    expect(sends(unscoped)[0]).toEqual({ type: 'chat-send', sessionId: 's-a', text: 'hello' })
    // A plan open with a displayed version: the capture happens when the draft
    // first becomes nonempty, and the send carries the envelope.
    const panel = boundPanel()
    expect(panel.has('composer-scope-unscoped')).toBe(false)
    type(panel, 'look at this plan')
    expect(panel.has('composer-scope')).toBe(true)
    submit(panel)
    expect(sends(panel)[0]).toMatchObject({
      type: 'chat-send', sessionId: 's-a', text: 'look at this plan',
      workspaceContext: { teamId: 't', planId: 'p1', version: { kind: 'revision', revision: 1, contentHash: 'hash-1-0123456789' } },
    })
    expect(sends(panel)[0]!.workspaceContext!.executionId).toBeUndefined()
  })

  test('navigation never mutates a nonempty draft capture: the send keeps the captured attachment', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    const scopeBefore = usePlanWorkspaceScopeStore.getState().scopes['s-a']
    // A new displayed version arrives (a revision was approved): the capture stays frozen.
    const selection2 = selectionWith([binding('architect', 's-a', 1)])
    selection2.snapshot = { ...selection2.snapshot,
      displayedVersion: { kind: 'revision', revision: 2, status: 'approved', contentHash: 'hash-2-0123456789' } }
    panel.rerender({ selection: selection2 })
    expect(usePlanWorkspaceScopeStore.getState().scopes['s-a']).toBe(scopeBefore)
    // Sending keeps the OLD attachment (no automatic replacement)…
    submit(panel)
    expect(sends(panel)[0]!.workspaceContext!.version)
      .toEqual({ kind: 'revision', revision: 1, contentHash: 'hash-1-0123456789' })
  })

  test('the mismatch is explained and replaced only by the explicit Replace attachment action', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    const selection2 = selectionWith([binding('architect', 's-a', 1)])
    selection2.snapshot = { ...selection2.snapshot,
      displayedVersion: { kind: 'revision', revision: 2, status: 'approved', contentHash: 'hash-2-0123456789' } }
    panel.rerender({ selection: selection2 })
    expect(panel.textOf(panel.byId('composer-scope'))).toContain('Now showing')
    // Replace attachment adopts exactly the shown selection, and only it.
    act(() => { panel.byId('composer-scope-replace').props.onClick() })
    expect(panel.textOf(panel.byId('composer-scope'))).not.toContain('Now showing')
    submit(panel)
    expect(sends(panel)[0]!.workspaceContext!.version)
      .toEqual({ kind: 'revision', revision: 2, contentHash: 'hash-2-0123456789' })
  })

  test('a refused contextual send restores the draft text and the attachment on its correlated refusal; nothing resends', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    submit(panel)
    expect(useChatStore.getState().drafts['s-a']).toBeUndefined()
    // The refusal echoes the send's client-minted requestId (Q2): that is the
    // only restore trigger.
    panel.deliver({ type: 'error', message: 'Workspace context is stale: revision has moved on.',
      requestId: sentRequestId(panel), sessionId: 's-a' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('hello')
    expect(panel.has('composer-scope')).toBe(true)
    expect(sends(panel)).toHaveLength(1)
    // The pending was consumed: even a correlated-looking later error restores
    // nothing, and a generic unrelated error never did.
    act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value: '' } }) })
    panel.deliver({ type: 'error', message: 'something else',
      requestId: 'different-request', sessionId: 's-a' })
    panel.deliver({ type: 'error', message: 'generic server error' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('')
  })

  test('a refusal without the send requestId restores nothing', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    submit(panel)
    // A legacy-shaped or mis-addressed error must not consume the pending.
    panel.deliver({ type: 'error', message: 'Workspace context is stale: revision has moved on.' })
    panel.deliver({ type: 'error', message: 'stale', requestId: sentRequestId(panel), sessionId: 'other' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('')
    expect(pendingContextSends.size).toBe(1)
    // The real correlated refusal still works afterwards.
    panel.deliver({ type: 'error', message: 'stale', requestId: sentRequestId(panel), sessionId: 's-a' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('hello')
  })

  test('an unrelated user_message never settles a pending send; a later correlated refusal still restores', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    submit(panel)
    // A user_message arrives — another host's send, or this one's own echo:
    // neither can be told apart, so neither settles the entry (B1).
    panel.deliver({ type: 'chat-events', sessionId: 's-a', events: [
      { id: 'u1', sequence: 1, at: '2026-10-24T09:00:00.000Z', turnId: 't1', type: 'user_message', text: 'hello' },
    ] })
    expect(pendingContextSends.size).toBe(1)
    // The correlated refusal still restores text and attachment afterwards.
    panel.deliver({ type: 'error', message: 'Workspace context is stale: revision has moved on.',
      requestId: sentRequestId(panel), sessionId: 's-a' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('hello')
    expect(panel.has('composer-scope')).toBe(true)
    expect(pendingContextSends.size).toBe(0)
    expect(sends(panel)).toHaveLength(1)
  })

  test('the sender-only acceptance drops the entry, in either order against the user_message frame', () => {
    // Acceptance first, user_message second.
    const first = boundPanel()
    type(first, 'one')
    submit(first)
    first.deliver({ type: 'chat-send-result', sessionId: 's-a', requestId: sentRequestId(first)!, accepted: true })
    expect(pendingContextSends.size).toBe(0)
    first.deliver({ type: 'chat-events', sessionId: 's-a', events: [
      { id: 'u1', sequence: 1, at: '2026-10-24T09:00:00.000Z', turnId: 't1', type: 'user_message', text: 'one' },
    ] })
    expect(first.renderer.root.findByType('textarea').props.value).toBe('')
    expect(sends(first)).toHaveLength(1)
    // user_message first, acceptance second: the outcome is the same.
    const second = boundPanel()
    type(second, 'two')
    submit(second)
    second.deliver({ type: 'chat-events', sessionId: 's-a', events: [
      { id: 'u2', sequence: 2, at: '2026-10-24T09:00:01.000Z', turnId: 't1', type: 'user_message', text: 'two' },
    ] })
    second.deliver({ type: 'chat-send-result', sessionId: 's-a', requestId: sentRequestId(second)!, accepted: true })
    expect(pendingContextSends.size).toBe(0)
    expect(second.renderer.root.findByType('textarea').props.value).toBe('')
    expect(sends(second)).toHaveLength(1)
  })

  test('rapid sends settle independently, each only on its own answer', () => {
    const panel = boundPanel()
    type(panel, 'first')
    submit(panel)
    const firstRequest = sentRequestAt(panel, 0)
    type(panel, 'second')
    submit(panel)
    const secondRequest = sentRequestAt(panel, 1)
    expect(firstRequest).not.toEqual(secondRequest)
    expect(pendingContextSends.size).toBe(2)
    // The second send's refusal consumes only its own entry; the draft was
    // empty (post-submit clear), so its text and attachment restore, and the
    // first entry stays pending.
    panel.deliver({ type: 'error', message: 'stale', requestId: secondRequest, sessionId: 's-a' })
    expect(pendingContextSends.size).toBe(1)
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('second')
    // The first send's acceptance drops the last entry, restoring nothing.
    panel.deliver({ type: 'chat-send-result', sessionId: 's-a', requestId: firstRequest!, accepted: true })
    expect(pendingContextSends.size).toBe(0)
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('second')
  })

  test('an answer naming another session never consumes this session entry', () => {
    const panel = boundPanel()
    type(panel, 'hello')
    submit(panel)
    const request = sentRequestId(panel)!
    panel.deliver({ type: 'chat-send-result', sessionId: 's-other', requestId: request, accepted: true })
    panel.deliver({ type: 'error', message: 'late', requestId: request, sessionId: 's-other' })
    expect(pendingContextSends.size).toBe(1)
    // The correctly addressed acceptance still settles it.
    panel.deliver({ type: 'chat-send-result', sessionId: 's-a', requestId: request, accepted: true })
    expect(pendingContextSends.size).toBe(0)
  })

  test('a disconnect restores the oldest unanswered send into an empty draft; the rest are retained, never resent', () => {
    const panel = boundPanel()
    type(panel, 'first text')
    submit(panel)
    const firstRequest = sentRequestAt(panel, 0)
    type(panel, 'second text')
    submit(panel)
    const secondRequest = sentRequestAt(panel, 1)
    panel.rerender({ connected: false })
    // The oldest fills the empty composer — recovery of unconfirmed text, no
    // resend — and the second entry stays retained.
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('first text')
    expect(panel.has('composer-scope')).toBe(true)
    expect(pendingContextSends.size).toBe(1)
    expect(sends(panel)).toHaveLength(2)
    // The restored send's late correlated refusal is moot (entry already
    // recovered); the retained entry's refusal cannot overwrite the restored
    // draft — restore needs an empty draft, so only the error shows.
    panel.deliver({ type: 'error', message: 'late', requestId: firstRequest, sessionId: 's-a' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('first text')
    panel.deliver({ type: 'error', message: 'stale', requestId: secondRequest, sessionId: 's-a' })
    expect(panel.renderer.root.findByType('textarea').props.value).toBe('first text')
    expect(pendingContextSends.size).toBe(0)
    // Emptying the text drops the restored scope.
    type(panel, '')
    expect(usePlanWorkspaceScopeStore.getState().scopes['s-a']).toBeUndefined()
  })
})
