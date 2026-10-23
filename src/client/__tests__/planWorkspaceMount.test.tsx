// The plan workspace mount inside the Plans view (plan-workspace 5.1): the
// section subscribes when a plan detail is shown, re-sends on reconnect and
// on a version or execution switch, ends subscriptions on plan switch and
// unmount, and shows the explicit no-version state without fabricating plan
// content. Opening the workspace never starts or attaches a worker, and
// every existing plan section and gate stays where it was.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import { normalizePlanContent, type PlanRevision } from '@shared/plans'
import type { WorkspaceSnapshot } from '@shared/planWorkspace'
import type { WorkspaceRuntimeView } from '@shared/planWorkspaceRuntime'
import type { PlanExecutionView } from '@shared/planExecution'
import TeamPlansView from '../components/team/TeamPlansView'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { planDetail, planSummary } from './planViewFixtures'
import PlanWorkspaceHealth from '../components/team/PlanWorkspaceHealth'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useTeamPlanStore.setState({ views: {}, reveal: null })
  useTeamPlanWorkspaceStore.setState({ views: {} })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const content = () => normalizePlanContent({
  goal: 'Ship the workspace', successCriteria: ['Sections retained'], approach: '',
  changes: [
    { change: 'api', group: 'middle-devs' },
    { change: 'web', dependsOn: ['api'], group: 'middle-devs' },
  ],
})
const revision = (number: number, status: PlanRevision['status']): PlanRevision => ({
  revision: number, status, content: content(), contentHash: `hash-${number}-0123456789`,
  pin: null, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-20T00:00:00.000Z',
})

const runtime = (): WorkspaceRuntimeView => ({
  execution: { executionId: 'e1', revision: 1 },
  changes: [
    { change: 'api', relation: 'overlay', executionRevision: 1, modifiedSinceExecution: false,
      state: { kind: 'landed', landedAt: '2026-10-22T00:00:00.000Z', treeVerified: true }, holders: [], history: [], checklist: { total: 4, checked: 4 } },
    { change: 'web', relation: 'overlay', executionRevision: 1, modifiedSinceExecution: false,
      state: { kind: 'waiting', cause: 'dependency api' }, holders: [], history: [], checklist: null },
  ],
  outside: { changes: [], tasks: [] },
})

const snapshot = (extra: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' },
  displayedVersion: { kind: 'revision', revision: 1, status: 'approved', contentHash: 'hash-1-0123456789' },
  bindings: [],
  references: [],
  runtime: runtime(),
  health: [{
    sessionId: 's1', name: 'Dev', relevance: 'holder',
    context: { used: 0.5, measuredAt: '2026-10-23T11:55:00.000Z' },
    quota: { status: 'ok', used: 0.4, resetsAt: '2026-10-24T00:00:00.000Z', measuredAt: '2026-10-23T11:55:00.000Z', source: 'provider' },
    quotaApplicable: true,
  }],
  ...extra,
})

const detail = () => {
  const plan = planSummary('p1', { currentApprovedRevision: 1, state: 'in-progress' })
  const execution = (id: string, rev: number, startedAt: string): PlanExecutionView => ({
    id, planId: 'p1', revision: rev, contentHash: `hash-${rev}`, reportId: `r-${rev}`, inputHash: `i-${rev}`,
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', maxParallel: 2, mergeMethod: 'merge',
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    state: 'running', outcome: null, stopReason: null, startedAt, finishedAt: null, changes: [],
  })
  return planDetail(plan, { revisions: [revision(1, 'approved'), revision(2, 'in_review')],
    executions: [execution('e2', 2, '2026-10-21T00:00:00.000Z'), execution('e1', 1, '2026-10-20T00:00:00.000Z')] })
}

const mount = (planFixture = detail()) => {
  useTeamPlanStore.getState().open('/repo')
  act(() => {
    useTeamPlanStore.getState().select('/repo', 'p1')
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: planFixture })
  })
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const element = (epoch = 0) => <TeamPlansView teamPath="/repo" view={useTeamPlanStore.getState().views['/repo']!}
    sendMessage={sendMessage} connected connectionEpoch={epoch} sessions={[]} />
  act(() => { renderer = TestRenderer.create(element()) })
  renderers.push(renderer)
  const rerender = (epoch = 0) => act(() => renderer.update(element(epoch)))
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  return { sent, rerender, byId, has, renderer }
}

const opens = (sent: ClientMessage[]) => sent.filter(message => message.type === 'team-plan-workspace-open')
const closes = (sent: ClientMessage[]) => sent.filter(message => message.type === 'team-plan-workspace-close')

test('the section subscribes on mount, renders the map from the snapshot, and switches version and execution', () => {
  const { sent, rerender, byId, has } = mount()
  expect(opens(sent).map(message => message.planId)).toEqual(['p1'])
  expect(has('plan-workspace-loading')).toBe(true)
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  expect(has('plan-workspace-loading')).toBe(false)
  expect(has('wbs-row-api')).toBe(true)
  expect(has('wbs-row-web')).toBe(true)
  expect(textOf(byId('workspace-displayed-label'))).toContain('revision 1')
  expect(textOf(byId('workspace-bindings'))).toContain('No repository chats bound yet')
  expect(has('plan-workspace-health')).toBe(true)
  // A version pick re-sends the open with the selector; the execution pick too.
  const before = opens(sent).length
  act(() => { byId('workspace-version-picker').props.onChange({ target: { value: 'rev:2' } }) })
  const pick = opens(sent)[before]!
  expect(pick.version).toEqual({ kind: 'revision', revision: 2 })
  const afterExecution = opens(sent).length
  act(() => { byId('workspace-execution-picker').props.onChange({ target: { value: 'e2' } }) })
  expect(opens(sent)[afterExecution]!.execution).toEqual({ executionId: 'e2' })
  // A reconnect epoch re-sends the subscription once.
  const beforeReconnect = opens(sent).length
  rerender(1)
  expect(opens(sent).length).toBe(beforeReconnect + 1)
})

test('checklists are lazy: expanding a row opens its subscription, collapsing closes it', () => {
  const { sent, byId } = mount()
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  expect(sent.filter(message => message.type === 'team-plan-workspace-checklist-open')).toEqual([])
  act(() => { byId('wbs-expand-api').props.onClick() })
  const [open] = sent.filter(message => message.type === 'team-plan-workspace-checklist-open')
  expect(open!.changeName).toBe('api')
  act(() => { byId('wbs-expand-api').props.onClick() })
  const [close] = sent.filter(message => message.type === 'team-plan-workspace-checklist-close')
  expect(close!.changeName).toBe('api')
})

test('the selected change subscribes to its canonical artifacts; switching sends close then open (B3)', () => {
  const { sent, byId, has, rerender } = mount()
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  expect(has('plan-workspace-artifacts')).toBe(false)
  expect(sent.filter(message => message.type === 'team-plan-workspace-artifacts-open')).toEqual([])
  // Selecting a change opens its enumeration.
  act(() => { byId('wbs-select-api').props.onClick() })
  expect(sent.filter(message => message.type === 'team-plan-workspace-artifacts-open')
    .map(message => message.changeName)).toEqual(['api'])
  expect(has('plan-workspace-artifacts-loading')).toBe(true)
  // The push renders the rows; an unobserved artifact reads `unread`.
  act(() => useTeamPlanWorkspaceStore.getState().applyArtifacts({
    type: 'team-plan-workspace-artifacts', teamPath: '/repo', planId: 'p1', changeName: 'api',
    view: {
      ok: true, changeName: 'api', source: { kind: 'main', worktreeId: '/repo' },
      artifacts: [{ kind: 'proposal', relativePath: 'openspec/changes/api/proposal.md' }],
    },
  }))
  expect(has('plan-workspace-artifacts-loading')).toBe(false)
  expect(textOf(byId('plan-workspace-artifacts-source'))).toContain('main checkout')
  const row = byId('plan-workspace-artifact-proposal')
  expect(textOf(byId('plan-workspace-artifact-proposal-state'))).toBe('unread')
  // Opening it routes through the existing document selection (B2)…
  act(() => { row.props.onClick() })
  expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.selectedDocument).toEqual({
    worktreeId: '/repo', relativePath: 'openspec/changes/api/proposal.md',
  })
  // …and the selected document-open alone supplies the real availability.
  act(() => useTeamPlanWorkspaceStore.getState().applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo', relativePath: 'openspec/changes/api/proposal.md',
    view: {
      worktreeId: '/repo', relativePath: 'openspec/changes/api/proposal.md', kind: 'markdown',
      availability: 'current', stale: false, reason: null, executionMatch: 'unknown', executionId: null,
      contentHash: 'abc', size: 10, mtimeMs: 1, text: '# p',
    },
  }))
  expect(textOf(byId('plan-workspace-artifact-proposal-state'))).toContain('current')
  // A reconnect epoch re-sends the enumeration onto the new connection.
  const beforeReconnect = sent.filter(message => message.type === 'team-plan-workspace-artifacts-open').length
  rerender(1)
  expect(sent.filter(message => message.type === 'team-plan-workspace-artifacts-open').length).toBe(beforeReconnect + 1)
  // Switching the selection closes the old enumeration, opens the new —
  // after the reconnect's own close/open pair. The stale `api` enumeration
  // never leaks into the new change's panel.
  act(() => { byId('wbs-select-web').props.onClick() })
  expect(has('plan-workspace-artifacts-loading')).toBe(true)
  expect(has('plan-workspace-artifacts-list')).toBe(false)
  const artifactCloses = sent.filter(message => message.type === 'team-plan-workspace-artifacts-close')
  expect(artifactCloses.map(message => message.changeName)).toEqual(['api', 'api'])
  expect(sent.filter(message => message.type === 'team-plan-workspace-artifacts-open')
    .map(message => message.changeName)).toEqual(['api', 'api', 'web'])
})

test('an unavailable enumeration renders its fixed reason; unmount closes the subscription', () => {
  const { sent, byId, has, renderer } = mount()
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  act(() => { byId('wbs-select-api').props.onClick() })
  act(() => useTeamPlanWorkspaceStore.getState().applyArtifacts({
    type: 'team-plan-workspace-artifacts', teamPath: '/repo', planId: 'p1', changeName: 'api',
    view: {
      ok: false, state: 'missing-in-worktree',
      message: 'Change "api" is missing in its convention worktree (active and archive listings); main checkout’s copy is not substituted.',
    },
  }))
  expect(has('plan-workspace-artifacts-list')).toBe(false)
  expect(textOf(byId('plan-workspace-artifacts-unavailable'))).toContain('missing in its convention worktree')
  // Unmount — as on leaving the plan or the team — closes the subscription.
  act(() => renderer.unmount())
  renderers.length = 0
  expect(sent.filter(message => message.type === 'team-plan-workspace-artifacts-close')
    .map(message => message.changeName)).toEqual(['api'])
})

test('no displayable version states itself and fabricates no map; loading holds before the snapshot', () => {
  const { has, byId } = mount()
  expect(has('plan-workspace-loading')).toBe(true)
  expect(has('wbs-row-api')).toBe(false)
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1',
    workspace: snapshot({ displayedVersion: null, runtime: undefined }),
  }))
  expect(textOf(byId('plan-workspace-no-version'))).toContain('no approved revision')
  // No fabricated content, no fabricated execution facts.
  expect(has('wbs-row-api')).toBe(false)
  expect(has('workspace-displayed-label')).toBe(false)
  expect(has('plan-workspace-runtime-unavailable')).toBe(false)
})

test('switching plans ends the old subscription before opening the new; unmount closes', () => {
  const { renderer, sent, rerender } = mount()
  act(() => {
    useTeamPlanWorkspaceStore.getState().applySnapshot({
      type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
    })
  })
  // A second plan with its own detail, so the section mounts for it too.
  // The store only keeps a detail for the selected plan, so select first.
  act(() => useTeamPlanStore.getState().select('/repo', 'p2'))
  rerender()
  // The p1 section unmounted with the switch: its subscription ended.
  expect(closes(sent).map(message => message.planId)).toEqual(['p1'])
  const plan2 = planSummary('p2', { currentApprovedRevision: 1 })
  act(() => useTeamPlanStore.getState().applyDetail({
    type: 'team-plan-detail', teamPath: '/repo', teamId: 't',
    detail: planDetail(plan2, { revisions: [revision(1, 'approved')] }),
  }))
  rerender()
  expect(opens(sent).at(-1)!.planId).toBe('p2')
  act(() => renderer.unmount())
  renderers.length = 0
  expect(closes(sent).map(message => message.planId)).toEqual(['p1', 'p2'])
  expect(opens(sent).length).toBe(2)
})

test('the workspace starts no worker and displaces no existing section or gate', () => {
  const { sent, has } = mount()
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  // Every message the workspace flow sends is a plans/workspace message —
  // never a chat attach, a task dispatch, or a session start.
  const allowed = new Set([
    'team-plans-open', 'team-plans-close', 'team-plan-open', 'team-plan-close',
    'team-plan-workspace-open', 'team-plan-workspace-close',
    'team-plan-workspace-checklist-open', 'team-plan-workspace-checklist-close',
    'team-plan-workspace-document-open', 'team-plan-workspace-document-close',
    'team-plan-workspace-artifacts-open', 'team-plan-workspace-artifacts-close',
  ])
  for (const message of sent) expect(allowed.has(message.type)).toBe(true)
  // The existing sections and their gates render beside the workspace.
  expect(has('plan-detail')).toBe(true)
  expect(has('plan-intent')).toBe(true)
  expect(has('plan-changes')).toBe(true)
  expect(has('plan-workspace')).toBe(true)
})

test('selection and filter survive leaving for a chat and coming back (5.4)', () => {
  const first = mount()
  act(() => useTeamPlanWorkspaceStore.getState().applySnapshot({
    type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1', workspace: snapshot(),
  }))
  act(() => first.byId('wbs-select-web').props.onClick())
  act(() => first.byId('wbs-filter-blocked').props.onClick())
  act(() => first.renderer.unmount())
  renderers.length = 0
  // The workspace store is keyed by team, not by the view's lifetime —
  // the chat visit is only an unmount away, and the selection comes back.
  const second = mount()
  expect(second.byId('wbs-row-web').props['data-selected']).toBe(true)
  // Blocked filter still applied: the landed change stays hidden.
  expect(second.has('wbs-row-api')).toBe(false)
})

test('the health list recomputes on a client clock at most a minute apart, cleared on unmount', () => {
  const original = globalThis.setInterval
  const registered: Array<[() => void, number]> = []
  const cleared: unknown[] = []
  // Register through to the real timer; capture the cadence and the handle.
  globalThis.setInterval = ((fn: () => void, ms: number, ...rest: unknown[]) => {
    registered.push([fn, ms])
    return original(fn, ms, ...(rest as []))
  }) as typeof globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.clearInterval = (handle: unknown, ...rest: unknown[]) => { cleared.push(handle); return realClear(handle as ReturnType<typeof setInterval>, ...(rest as [])) }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<PlanWorkspaceHealth readings={[{
    sessionId: 's1', name: 'Dev', relevance: 'holder',
    context: { used: 0.5, measuredAt: new Date(Date.now() - 1000).toISOString() },
    quota: { status: 'ok', used: 0.4, resetsAt: new Date(Date.now() + 3600_000).toISOString(), measuredAt: new Date(Date.now() - 1000).toISOString(), source: 'provider' },
    quotaApplicable: true,
  }]} connected />) })
  renderers.push(renderer)
  expect(registered.length).toBe(1)
  expect(registered[0]![1]).toBeLessThanOrEqual(60_000)
  // The tick re-renders through the shared derivation with the new now.
  expect(renderer.root.findByProps({ 'data-testid': 'workspace-health-dot-s1' }).props['data-level']).toBe('green')
  act(() => { registered[0]![0]() })
  expect(renderer.root.findByProps({ 'data-testid': 'workspace-health-dot-s1' }).props['data-level']).toBe('green')
  act(() => renderer.unmount())
  renderers.length = 0
  expect(cleared.length).toBe(1)
  globalThis.setInterval = original
  globalThis.clearInterval = realClear
})
