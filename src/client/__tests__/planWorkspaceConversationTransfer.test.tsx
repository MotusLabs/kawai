// Reset-transfer and create-then-bind behavior of the repository conversation
// panel, against the canonical team bindings slot (plan-workspace §6.4,
// review B2/B3/B5): a binding known only through the bindings push — never a
// plan snapshot — transfers on a local reset, including after the Plans view
// closed; a transfer's keyed result settles it and a conflict (the winner
// kept the role) is explained beside the created chat, with a transfer issued
// while the panel was closed derived from the slot at mount and an in-flight
// one waiting for its result; and the create-then-bind arm is explicit and
// scoped to its dialog flow — a dialog cancel disarms it, a create-close
// keeps it for the created chat, a picker pick abandons it, and a concurrent
// binding committed while armed is never replaced by the late creation.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ComponentProps } from 'react'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import type { WorkspaceBindingView, WorkspaceSnapshot } from '@shared/planWorkspace'
import PlanWorkspaceConversation from '../components/team/PlanWorkspaceConversation'
import { transferBindingsOnReset } from '../utils/planWorkspaceResetTransfer'
import { useChatStore } from '../stores/chatStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { usePlanWorkspaceScopeStore } from '../stores/planWorkspaceScopeStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  useWorkspaceStore.setState({ snapshot: null })
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
})

const makeSession = (id: string, overrides: Partial<Session> = {}) =>
  ({
    id, name: id, projectPath: '/repo', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual', ...overrides,
  }) as unknown as Session

const binding = (role: 'architect' | 'lead', sessionId: string, version: number,
  availability: WorkspaceBindingView['availability'] = 'live'): WorkspaceBindingView =>
  ({ role, sessionId, version, availability, name: sessionId })

const seedBindings = (teamPath: string, bindings: WorkspaceBindingView[]) => act(() => {
  useTeamPlanWorkspaceStore.getState().applyBindings({
    type: 'team-plan-workspace-bindings', teamPath, teamId: 't', bindings,
  })
})

const createdSession = (id: string, projectPath = '/repo'): Extract<ServerMessage, { type: 'session-created' }> =>
  ({ type: 'session-created', session: {
    id, name: id, kind: 'chat', projectPath,
    status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
  } as unknown as Session })

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
  const sentBinds = () => sent.filter(message => message.type === 'team-plan-workspace-bind')
  return { sent, renderer, element, deliver, byId, has, textOf, sentBinds,
    rerender: (extra: Partial<PanelProps> = {}) => act(() => renderer.update(element(extra))) }
}

/** Types /clear into the bound role's composer and submits the reset. */
const submitReset = (panel: ReturnType<typeof mountPanel>) => {
  act(() => { panel.renderer.root.findByType('textarea').props.onChange({ target: { value: '/clear' } }) })
  act(() => { panel.renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
}

/** The requestId of the reset transfer's bind, from the recorded attempt. */
const transferRequestId = (): string => {
  const [attempt] = usePlanWorkspaceScopeStore.getState().attempts['/repo'] ?? []
  if (attempt?.action.kind !== 'sent') throw new Error('no sent transfer attempt recorded')
  return attempt.action.requestId
}

describe('reset transfer reads the canonical bindings slot (B3)', () => {
  test('a binding known only through the bindings push — no plan snapshot ever — transfers on reset', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2), binding('lead', 's-lead', 1)])
    const panel = mountPanel({ sessions: [makeSession('s-old'), makeSession('s-lead')] })
    submitReset(panel)
    panel.deliver(createdSession('s-new'))
    const binds = panel.sentBinds()
    expect(binds).toEqual([{ type: 'team-plan-workspace-bind', teamPath: '/repo',
      requestId: expect.any(String), commandId: expect.any(String),
      role: 'architect', sessionId: 's-new', expectedVersion: 2 }])
    expect(panel.sent).toContainEqual({ type: 'chat-archive', sessionId: 's-old' })
    // The Lead's binding (s-lead) is never part of the transfer.
    expect(binds.filter(message => message.role === 'lead')).toEqual([])
  })

  test('a binding observed through a plan snapshot still transfers after the Plans view closed', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2)])
    act(() => {
      useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
      useTeamPlanWorkspaceStore.getState().applySnapshot({
        type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1',
        workspace: { plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' },
          displayedVersion: { kind: 'revision', revision: 1, status: 'approved', contentHash: 'hash-1' },
          bindings: [binding('architect', 's-old', 2)], references: [] } as WorkspaceSnapshot,
      })
      useTeamPlanWorkspaceStore.getState().close('/repo')
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']).toBeUndefined()
    const panel = mountPanel({ sessions: [makeSession('s-old')] })
    submitReset(panel)
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toMatchObject([{ role: 'architect', sessionId: 's-new', expectedVersion: 2 }])
  })
})

describe('transfer conflicts are shown, never retried (B2)', () => {
  test('a refused transfer names the created chat and the winner; the winner stays bound', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2), binding('lead', 's-lead', 1)])
    const panel = mountPanel({
      sessions: [makeSession('s-old'), makeSession('s-lead'), makeSession('s-new')],
    })
    submitReset(panel)
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toHaveLength(1)
    // A concurrent explicit replacement committed first: the slot moved on.
    act(() => {
      useTeamPlanWorkspaceStore.getState().applyBindings({
        type: 'team-plan-workspace-bindings', teamPath: '/repo', teamId: 't',
        bindings: [binding('architect', 's-winner', 3), binding('lead', 's-lead', 1)],
      })
    })
    panel.deliver({ type: 'team-plan-workspace-result', teamPath: '/repo',
      requestId: transferRequestId(), error: 'stale: binding moved to version 3' })
    expect(panel.has('conversation-transfer-conflict')).toBe(true)
    const text = panel.textOf(panel.byId('conversation-transfer-conflict'))
    expect(text).toContain('s-new')
    expect(text).toContain('s-old')
    expect(text).toContain('stale: binding moved to version 3')
    // The winner stays bound and nothing re-binds the created chat (no
    // write-only attempt, no automatic retry).
    expect(useTeamPlanWorkspaceStore.getState().teamBindings['/repo']
      .find(entry => entry.role === 'architect')?.sessionId).toBe('s-winner')
    expect(panel.sentBinds()).toHaveLength(1)
    // The conflict survives a re-render (the attempts are kept per team).
    panel.rerender()
    expect(panel.has('conversation-transfer-conflict')).toBe(true)
  })

  test('a transfer issued while the panel was closed derives its conflict at mount from the slot', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2)])
    const sentElsewhere: ClientMessage[] = []
    transferBindingsOnReset(message => { sentElsewhere.push(message) }, 's-new', 's-old')
    expect(sentElsewhere).toMatchObject([{ type: 'team-plan-workspace-bind',
      role: 'architect', sessionId: 's-new', expectedVersion: 2 }])
    const panel = mountPanel({ sessions: [makeSession('s-old'), makeSession('s-new')] })
    // No result ever arrived; the slot proves the role did not move.
    expect(panel.has('conversation-transfer-conflict')).toBe(true)
    const text = panel.textOf(panel.byId('conversation-transfer-conflict'))
    expect(text).toContain('s-new')
    expect(text).toContain('s-old')
    expect(text).toContain('moved on concurrently')
    // The panel itself never re-binds: mounting explains, it does not write.
    expect(panel.sentBinds()).toEqual([])
  })

  test('a transfer that appears while mounted waits for its result — no premature conflict', () => {
    seedBindings('/repo', [binding('architect', 's-old', 2)])
    const panel = mountPanel({ sessions: [makeSession('s-old'), makeSession('s-new')] })
    const sentElsewhere: ClientMessage[] = []
    transferBindingsOnReset(message => { sentElsewhere.push(message) }, 's-new', 's-old')
    expect(panel.has('conversation-transfer-conflict')).toBe(false)
    // The result confirms the transfer committed: no conflict, ever.
    panel.deliver({ type: 'team-plan-workspace-result', teamPath: '/repo',
      requestId: transferRequestId() })
    act(() => {
      useTeamPlanWorkspaceStore.getState().applyBindings({
        type: 'team-plan-workspace-bindings', teamPath: '/repo', teamId: 't',
        bindings: [binding('architect', 's-new', 3)],
      })
    })
    expect(panel.has('conversation-transfer-conflict')).toBe(false)
  })
})

describe('create-then-bind arm is scoped to its dialog flow (B5)', () => {
  let dismissed: ((created: boolean) => void) | undefined

  const mountArmed = () => {
    seedBindings('/repo', [binding('lead', 's-lead', 1)])
    dismissed = undefined
    const panel = mountPanel({
      sessions: [makeSession('s-a'), makeSession('s-lead')],
      onOpenNewSession: callback => { dismissed = callback },
    })
    act(() => { panel.byId('conversation-new-chat-architect').props.onClick() })
    expect(dismissed).not.toBeNull()
    return panel
  }

  test('a dialog cancel disarms: a later unrelated same-team creation binds nothing', () => {
    const panel = mountArmed()
    act(() => { dismissed!(false) })
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toEqual([])
  })

  test('a create-close keeps the arm; the created chat binds with the version the arm observed', () => {
    const panel = mountArmed()
    // The dialog closes as part of Create, before the session-created reply.
    act(() => { dismissed!(true) })
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toEqual([{ type: 'team-plan-workspace-bind', teamPath: '/repo',
      requestId: expect.any(String), commandId: expect.any(String),
      role: 'architect', sessionId: 's-new', expectedVersion: null }])
  })

  test('an explicit picker pick abandons the arm; a late creation binds nothing', () => {
    const panel = mountArmed()
    panel.byId('conversation-bind-picker').props.onChange({ target: { value: 's-a' } })
    expect(panel.sentBinds()).toEqual([{ type: 'team-plan-workspace-bind', teamPath: '/repo',
      requestId: expect.any(String), commandId: expect.any(String),
      role: 'architect', sessionId: 's-a', expectedVersion: null }])
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toHaveLength(1)
  })

  test('a concurrent binding committed while armed is never replaced by the late creation', () => {
    const panel = mountArmed()
    act(() => {
      useTeamPlanWorkspaceStore.getState().applyBindings({
        type: 'team-plan-workspace-bindings', teamPath: '/repo', teamId: 't',
        bindings: [binding('architect', 's-a', 1), binding('lead', 's-lead', 1)],
      })
    })
    panel.deliver(createdSession('s-new'))
    expect(panel.sentBinds()).toEqual([])
    expect(useTeamPlanWorkspaceStore.getState().teamBindings['/repo']
      .find(entry => entry.role === 'architect')?.sessionId).toBe('s-a')
  })
})
