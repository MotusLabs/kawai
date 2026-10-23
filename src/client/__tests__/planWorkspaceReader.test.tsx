// The plan workspace reader component (plan-workspace 5.3): references open
// and close the document subscription, add/remove send scoped payloads, the
// displayed document shows provenance with current/last-valid/broken states,
// and nested relative links navigate within the reader while refused targets
// render inert.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkspaceDocumentView, WorkspaceRefView } from '@shared/planWorkspace'
import PlanWorkspaceReader, { type ReaderRefAdd } from '../components/team/PlanWorkspaceReader'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useTeamPlanWorkspaceStore.setState({ views: {} })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const ref = (id: string, extra: Partial<WorkspaceRefView> = {}): WorkspaceRefView => ({
  id, planId: 'p1', label: `Ref ${id}`, kind: 'local', changeName: null,
  worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md', url: null,
  createdAt: '2026-10-20T00:00:00.000Z',
  ...extra,
})

const document = (extra: Partial<WorkspaceDocumentView> = {}): WorkspaceDocumentView => ({
  worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md', kind: 'markdown',
  availability: 'current', stale: false, reason: null, executionMatch: 'unknown', executionId: null,
  contentHash: 'a1b2c3d4e5f6a7b8', size: 240, mtimeMs: 1, text: '# Architecture\n\nSee [design](design.md).',
  ...extra,
})

const worktrees = [{ path: '/repo', label: 'repo (main)' }, { path: '/repo/.worktrees/wt', label: 'wt' }]

const mount = (refs: WorkspaceRefView[] = [ref('r1')]) => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
  useTeamPlanWorkspaceStore.getState().applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md', view: document(),
  })
  useTeamPlanWorkspaceStore.getState().openDocument('/repo', { worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md' })
  const opened: Array<{ worktreeId: string; relativePath: string } | null> = []
  const added: ReaderRefAdd[] = []
  const removed: string[] = []
  const element = () => <PlanWorkspaceReader teamPath="/repo" refs={refs} selectedChange={null}
    executionId={null} view={useTeamPlanWorkspaceStore.getState().views['/repo']!} worktrees={worktrees}
    connected
    onOpenDocument={selection => { opened.push(selection) }}
    onAddRef={payload => added.push(payload)} onRemoveRef={id => removed.push(id)} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element()) })
  renderers.push(renderer)
  const rerender = () => act(() => renderer.update(element()))
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  return { renderer, opened, added, removed, rerender, byId }
}

test('references list with open/close and remove; an unavailable local ref reads broken', () => {
  const { renderer, opened, removed, rerender, byId } = mount([ref('r1'), ref('r2', { label: 'Spec', kind: 'external', url: 'https://example.internal/spec', worktreeId: null, relativePath: null })])
  expect(textOf(byId('reader-ref-r1'))).toContain('docs/architecture.md')
  const spec = byId('reader-ref-r2')
  expect(textOf(spec)).toContain('https://example.internal/spec')
  // The document starts open, so the first toggle closes it…
  act(() => { byId('reader-open-r1').props.onClick() })
  expect(opened).toEqual([null])
  // …and with the selection cleared the same button opens it again.
  useTeamPlanWorkspaceStore.getState().openDocument('/repo', null)
  rerender()
  act(() => { byId('reader-open-r1').props.onClick() })
  expect(opened[1]).toEqual({ worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md' })
  act(() => { byId('reader-remove-r1').props.onClick() })
  expect(removed).toEqual(['r1'])
  // A missing (never-served) document marks the ref broken.
  const brokenStore = useTeamPlanWorkspaceStore.getState()
  brokenStore.applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md',
    view: document({ availability: 'missing', stale: false, reason: 'missing', kind: null, text: null, contentHash: null, size: null }),
  })
  act(() => { renderer.update(<PlanWorkspaceReader teamPath="/repo" refs={[ref('r1')]} selectedChange={null}
    executionId={null} view={useTeamPlanWorkspaceStore.getState().views['/repo']!} worktrees={worktrees}
    connected onOpenDocument={() => undefined} onAddRef={() => undefined} onRemoveRef={() => undefined} />) })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'reader-broken-r1' }))).toContain('missing')
})

test('the add form sends a scoped payload: change scope when a change is selected', () => {
  const { renderer, added, byId } = mount([])
  act(() => { byId('reader-add-ref').props.onClick() })
  // One act per keystroke: React batches within one act, so the confirm
  // click would otherwise see the form's initial empty state.
  act(() => { renderer.root.findByProps({ 'aria-label': 'Reference label' }).props.onChange({ target: { value: 'Architecture' } }) })
  act(() => { renderer.root.findByProps({ 'aria-label': 'Relative path' }).props.onChange({ target: { value: 'docs/architecture.md' } }) })
  act(() => { byId('reader-add-confirm').props.onClick() })
  expect(added[0]).toEqual({
    label: 'Architecture', kind: 'local', worktreeId: '/repo', relativePath: 'docs/architecture.md',
  })
})

test('the displayed document shows provenance and renders nested links through the reader', () => {
  const { renderer, opened, byId } = mount()
  const provenance = textOf(byId('reader-document-provenance'))
  expect(provenance).toContain('wt')
  expect(provenance).toContain('docs/architecture.md')
  expect(provenance).toContain('a1b2c3d')
  expect(textOf(byId('reader-document-state'))).toContain('Current file')
  // The nested sibling link navigates within the reader (no page fetch).
  const link = renderer.root.findByProps({ 'data-reader-link': 'docs/design.md' })
  expect(link.type).toBe('button')
  act(() => { link.props.onClick() })
  expect(opened[opened.length - 1]).toEqual({ worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/design.md' })
})

test('stale last-valid content, unsupported types, and refused images show their states', () => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
  useTeamPlanWorkspaceStore.getState().applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md',
    view: document({ availability: 'missing', stale: true, reason: 'unreadable', text: '![pic](img.png)\n\n![remote](https://example.internal/pic.png)', executionMatch: 'mismatch', executionId: 'exec-1234567890' }),
  })
  useTeamPlanWorkspaceStore.getState().openDocument('/repo', { worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/architecture.md' })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PlanWorkspaceReader teamPath="/repo" refs={[]} selectedChange={null}
      executionId="exec-1234567890" view={useTeamPlanWorkspaceStore.getState().views['/repo']!} worktrees={worktrees}
      connected onOpenDocument={() => undefined} onAddRef={() => undefined} onRemoveRef={() => undefined} />)
  })
  renderers.push(renderer)
  const text = (id: string) => textOf(renderer.root.findByProps({ 'data-testid': id }))
  expect(text('reader-document-state')).toContain('last valid content')
  expect(text('reader-document-state')).toContain('unreadable')
  expect(text('reader-document-state')).toContain('differs')
  // The relative image renders through the scoped asset route…
  const image = renderer.root.findByProps({ 'data-reader-image': 'docs/img.png' })
  expect(String(image.props.src)).toContain('/api/plan-workspace/asset')
  // …and a remote image is refused in place, never fetched.
  const refused = renderer.root.findAllByProps({ 'data-refused-reason': 'external' })
  expect(refused.length).toBe(1)
})

test('a standalone image document renders through the scoped asset route, never WS bytes', () => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
  useTeamPlanWorkspaceStore.getState().applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/mockup.png',
    view: document({ relativePath: 'docs/mockup.png', kind: 'image', text: null }),
  })
  useTeamPlanWorkspaceStore.getState().openDocument('/repo', { worktreeId: '/repo/.worktrees/wt', relativePath: 'docs/mockup.png' })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PlanWorkspaceReader teamPath="/repo" refs={[]} selectedChange={null}
      executionId={null} view={useTeamPlanWorkspaceStore.getState().views['/repo']!} worktrees={worktrees}
      connected onOpenDocument={() => undefined} onAddRef={() => undefined} onRemoveRef={() => undefined} />)
  })
  renderers.push(renderer)
  const image = renderer.root.findByProps({ 'data-testid': 'reader-document-image' })
  const url = new URL(String(image.props.src), 'http://localhost')
  expect(url.pathname).toBe('/api/plan-workspace/asset')
  expect(url.searchParams.get('worktree')).toBe('/repo/.worktrees/wt')
  expect(url.searchParams.get('path')).toBe('docs/mockup.png')
})

test('an unsupported file type names the reason; no document shows the empty state', () => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
  useTeamPlanWorkspaceStore.getState().applyDocument({
    type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
    worktreeId: '/repo/.worktrees/wt', relativePath: 'archive.tar.gz',
    view: document({ relativePath: 'archive.tar.gz', kind: null, text: null, availability: 'current' }),
  })
  useTeamPlanWorkspaceStore.getState().openDocument('/repo', { worktreeId: '/repo/.worktrees/wt', relativePath: 'archive.tar.gz' })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PlanWorkspaceReader teamPath="/repo" refs={[]} selectedChange={null}
      executionId={null} view={useTeamPlanWorkspaceStore.getState().views['/repo']!} worktrees={worktrees}
      connected onOpenDocument={() => undefined} onAddRef={() => undefined} onRemoveRef={() => undefined} />)
  })
  renderers.push(renderer)
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'reader-document-unsupported' }))).toContain('not rendered')
})
