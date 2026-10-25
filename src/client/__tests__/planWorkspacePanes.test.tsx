// The workspace pane layout (plan-workspace 7.2, design D8): the desktop
// layout's divider is a real separator control — a bounded, labelled keyboard
// step beside the pointer drag — the expand and conversation controls write
// their per-team store state, the narrow layout is an explicit
// Map/Documents/Conversation navigation whose switch shows one pane and
// states itself, and a pane's remembered scroll survives remount. The two
// layouts mount separately here; the default export's width pick is a pure
// function beside them, and the real switch runs in the browser fixture.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import PlanWorkspacePanes, {
  WorkspaceNarrowPanes, WORKSPACE_NARROW_MAX_PX, workspaceLayoutForWidth,
} from '../components/team/PlanWorkspacePanes'
import {
  defaultPanes, useTeamPlanWorkspaceStore,
} from '../stores/teamPlanWorkspaceStore'
import { clearPaneScrollsForTests, paneScrollOf } from '../utils/planWorkspacePaneScroll'

const renderers: TestRenderer.ReactTestRenderer[] = []

const CONTENT = {
  map: <div>map content</div>,
  documents: <div>documents content</div>,
  conversation: <div>conversation content</div>,
}

const mountPanes = (teamKey = '/repo') => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PlanWorkspacePanes teamKey={teamKey} {...CONTENT} />)
  })
  renderers.push(renderer)
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  return { renderer, byId, has }
}

/** The narrow layout with the store's live pane state, as the chooser renders it. */
const NarrowHost = ({ teamKey }: { teamKey: string }) => {
  const panes = useTeamPlanWorkspaceStore(state => state.panes[teamKey]) ?? defaultPanes()
  const rootRef = useRef<HTMLElement | null>(null)
  return <WorkspaceNarrowPanes teamKey={teamKey} panes={panes} rootRef={rootRef} content={CONTENT} />
}

const mountNarrow = (teamKey = '/repo') => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<NarrowHost teamKey={teamKey} />) })
  renderers.push(renderer)
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  return { renderer, byId, has }
}

beforeEach(() => {
  useTeamPlanWorkspaceStore.setState({ views: {}, roles: {}, panes: {} })
  clearPaneScrollsForTests()
})

afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
})

test('the layout flips at the narrow bound', () => {
  expect(workspaceLayoutForWidth(WORKSPACE_NARROW_MAX_PX - 1)).toBe('narrow')
  expect(workspaceLayoutForWidth(WORKSPACE_NARROW_MAX_PX)).toBe('desktop')
})

test('the desktop divider exposes its bounded value and the keyboard steps move it', () => {
  const { byId } = mountPanes()
  const divider = byId('workspace-panes-divider')
  expect(divider.props.role).toBe('separator')
  expect(divider.props['aria-valuemin']).toBe(15)
  expect(divider.props['aria-valuemax']).toBe(70)
  expect(divider.props['aria-valuenow']).toBe(45)
  act(() => divider.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} }))
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBeCloseTo(0.48)
  act(() => divider.props.onKeyDown({ key: 'Home', preventDefault: () => {} }))
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBe(0.15)
  act(() => divider.props.onKeyDown({ key: 'End', preventDefault: () => {} }))
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBe(0.7)
  // Clamped at the maximum, never past it.
  act(() => divider.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} }))
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBe(0.7)
  act(() => divider.props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} }))
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBeCloseTo(0.67)
})

test('the expand controls swap the desktop layout to one pane and back, per team', () => {
  const { byId, has } = mountPanes()
  expect(has('workspace-pane-map')).toBe(true)
  expect(has('workspace-pane-documents')).toBe(true)
  expect(has('workspace-pane-conversation')).toBe(true)
  const expand = byId('workspace-expand-documents')
  expect(expand.props['aria-pressed']).toBe(false)
  act(() => expand.props.onClick())
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBe('reader')
  expect(has('workspace-pane-documents')).toBe(true)
  expect(has('workspace-pane-map')).toBe(false)
  expect(has('workspace-pane-conversation')).toBe(false)
  act(() => byId('workspace-expand-documents').props.onClick())
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBeNull()
  expect(has('workspace-pane-map')).toBe(true)
  // Another team's panes are untouched (per-team state).
  act(() => byId('workspace-expand-conversation').props.onClick())
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBe('conversation')
  expect(useTeamPlanWorkspaceStore.getState().panes['/other']).toBeUndefined()
})

test('the conversation toggle hides the right column without touching the resizable area', () => {
  const { byId, has } = mountPanes()
  expect(byId('workspace-conversation-toggle').props['aria-pressed']).toBe(true)
  act(() => byId('workspace-conversation-toggle').props.onClick())
  expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.conversationOpen).toBe(false)
  expect(has('workspace-pane-conversation')).toBe(false)
  expect(has('workspace-pane-map')).toBe(true)
  expect(has('workspace-panes-divider')).toBe(true)
  act(() => byId('workspace-conversation-toggle').props.onClick())
  expect(has('workspace-pane-conversation')).toBe(true)
})

describe('the narrow navigation', () => {
  test('a narrow host shows one pane behind an explicit Map/Documents/Conversation navigation', () => {
    const { byId, has } = mountNarrow()
    const layout = byId('plan-workspace-panes')
    expect(layout.props['data-layout']).toBe('narrow')
    // No desktop controls on the narrow layout.
    expect(has('workspace-panes-divider')).toBe(false)
    expect(has('workspace-expand-documents')).toBe(false)
    expect(has('workspace-pane-map')).toBe(true)
    expect(has('workspace-pane-documents')).toBe(false)
    const tabs = rendererTabs(byId('workspace-narrow-nav'))
    expect(tabs.map(tab => tab.props['aria-selected'])).toEqual([true, false, false])
    act(() => byId('workspace-narrow-documents').props.onClick())
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.narrowPane).toBe('documents')
    expect(has('workspace-pane-documents')).toBe(true)
    expect(has('workspace-pane-map')).toBe(false)
    expect(byId('workspace-narrow-documents').props['aria-selected']).toBe(true)
    // The status names the shown pane for text-only users.
    expect(statusText(byId('workspace-narrow-status'))).toContain('Documents pane')
    // The Back control returns to the map; the selection state never moved.
    act(() => byId('workspace-narrow-back').props.onClick())
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.narrowPane).toBe('map')
    expect(has('workspace-pane-map')).toBe(true)
    expect(has('workspace-narrow-back')).toBe(false)
  })

  test('opening the conversation from the narrow navigation clears its dismissed state', () => {
    const { byId, has } = mountNarrow()
    act(() => useTeamPlanWorkspaceStore.getState().setConversationOpen('/repo', false))
    act(() => byId('workspace-narrow-conversation').props.onClick())
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.conversationOpen).toBe(true)
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.narrowPane).toBe('conversation')
    expect(has('workspace-pane-conversation')).toBe(true)
  })

  test('a pane records its scroll per team; the restore itself runs in the browser fixture (RTR attaches no host refs)', () => {
    const first = mountNarrow()
    const mapPane = first.byId('workspace-pane-map')
    act(() => mapPane.props.onScroll({ currentTarget: { scrollTop: 42 } }))
    expect(paneScrollOf('/repo', 'map')).toBe(42)
    // Another team's scroll record is its own.
    act(() => useTeamPlanWorkspaceStore.getState().setNarrowPane('/other', 'map'))
    const other = mountNarrow('/other')
    act(() => other.byId('workspace-pane-map').props.onScroll({ currentTarget: { scrollTop: 7 } }))
    expect(paneScrollOf('/other', 'map')).toBe(7)
    expect(paneScrollOf('/repo', 'map')).toBe(42)
  })
})

/** The tab buttons inside the narrow navigation, in DOM order. */
const rendererTabs = (nav: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] =>
  nav.findAll(node => node.props.role === 'tab')

const statusText = (node: TestRenderer.ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : statusText(child)).join('')

test('a team with no pane state reads the defaults, and the store default fills the same shape', () => {
  const { byId } = mountPanes('/fresh')
  expect(useTeamPlanWorkspaceStore.getState().panes['/fresh']).toBeUndefined()
  expect(byId('workspace-panes-divider').props['aria-valuenow']).toBe(45)
  expect(defaultPanes()).toEqual({
    readerFraction: 0.45, expandedPane: null, narrowPane: 'map', conversationOpen: true,
  })
})
