// WorktreeGroupHeader.test.tsx - Task 6.1 coverage: repository/worktree group
// header states — clean, dirty, detached, stale, collapsed, hidden permission,
// counts, collapse control, accessible labels, and the trailing actions slot.
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorktreeGroup } from '../utils/workspaceView'
import WorktreeGroupHeader from '../components/WorktreeGroupHeader'

function makeGroup(overrides: Partial<WorktreeGroup> = {}): WorktreeGroup {
  return {
    kind: 'worktree',
    worktreeId: '/repo/.git::/repo',
    repositoryId: '/repo/.git',
    repositoryName: 'repo',
    repositoryStale: false,
    worktreePath: '/repo',
    branch: 'main',
    detached: false,
    headRevision: 'aaaaaaa1aaaaaaa1',
    isMain: true,
    dirty: false,
    openspec: { changes: [], stale: false },
    collapsed: false,
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
    ...overrides,
  }
}

function renderHeader(group: WorktreeGroup, onToggleCollapse: (worktreeId: string) => void = () => {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <WorktreeGroupHeader group={group} onToggleCollapse={onToggleCollapse} />
    )
  })
  return renderer
}

function headerByTestId(renderer: TestRenderer.ReactTestRenderer) {
  const header = renderer.root.findByProps({ 'data-testid': 'worktree-group-header' })
  if (!header) throw new Error('Expected worktree group header')
  return header
}

describe('WorktreeGroupHeader', () => {
  test('clean worktree shows repository, branch, and counts without state badges', () => {
    const group = makeGroup({
      entries: [
        { key: 's1', kind: 'live' },
        { key: 'h1', kind: 'hibernating' },
      ] as WorktreeGroup['entries'],
    })
    const renderer = renderHeader(group)
    const header = headerByTestId(renderer)
    const json = JSON.stringify(renderer.toJSON())

    expect(header.props['data-branch']).toBe('main')
    expect(header.props['data-detached']).toBe('false')
    expect(header.props['data-dirty']).toBe('false')
    expect(header.props['data-stale']).toBe('false')
    expect(header.props['data-session-count']).toBe(2)
    expect(json).toContain('repo')
    expect(json).toContain('main')
    // No state badges and no sr-only state summary on a clean worktree.
    expect(
      renderer.root.findAllByProps({ title: 'Working tree has tracked or untracked changes' })
    ).toHaveLength(0)
    expect(
      renderer.root.findAllByProps({ title: 'Git discovery failed; showing last known state' })
    ).toHaveLength(0)
    expect(json).not.toContain('(dirty)')
    expect(json).not.toContain('(stale)')

    act(() => renderer.unmount())
  })

  test('dirty worktree shows the dirty badge and sr-only state label', () => {
    const renderer = renderHeader(makeGroup({ dirty: true }))
    const header = headerByTestId(renderer)
    expect(header.props['data-dirty']).toBe('true')

    const badge = renderer.root.findByProps({ title: 'Working tree has tracked or untracked changes' })
    expect(badge.props.children).toBe('dirty')
    expect(JSON.stringify(renderer.toJSON())).toContain('(dirty)')

    act(() => renderer.unmount())
  })

  test('detached worktree shows a shortened revision instead of a branch', () => {
    const renderer = renderHeader(
      makeGroup({ branch: undefined, detached: true, worktreePath: '/repo-detached' })
    )
    const header = headerByTestId(renderer)
    const json = JSON.stringify(renderer.toJSON())

    expect(header.props['data-detached']).toBe('true')
    expect(header.props['data-branch']).toBe('')
    expect(json).toContain('@aaaaaaa')
    expect(json).not.toContain('@aaaaaaa1aaaaaaa1')
    expect(json).toContain('(detached)')

    const identity = renderer.root.findByProps({ title: 'Detached HEAD at aaaaaaa1aaaaaaa1' })
    expect(identity).toBeTruthy()

    act(() => renderer.unmount())
  })

  test('stale repository shows the stale badge with its error message', () => {
    const renderer = renderHeader(
      makeGroup({ repositoryStale: true, repositoryError: 'git failed' })
    )
    const header = headerByTestId(renderer)
    expect(header.props['data-stale']).toBe('true')

    const badge = renderer.root.findByProps({ title: 'git failed' })
    expect(badge.props.children).toBe('stale')
    expect(JSON.stringify(renderer.toJSON())).toContain('(stale)')

    act(() => renderer.unmount())
  })

  test('stale badge falls back to a generic title without an error message', () => {
    const renderer = renderHeader(makeGroup({ repositoryStale: true }))
    const badge = renderer.root.findByProps({
      title: 'Git discovery failed; showing last known state',
    })
    expect(badge).toBeTruthy()
    act(() => renderer.unmount())
  })

  test('collapsed worktree announces Expand and reports aria-expanded=false', () => {
    const renderer = renderHeader(makeGroup({ collapsed: true }))
    const button = renderer.root.findByProps({ 'aria-expanded': false })
    expect(button.props['aria-label']).toBe('Expand repo worktree /repo')

    const expandedRenderer = renderHeader(makeGroup({ collapsed: false }))
    const expandedButton = expandedRenderer.root.findByProps({ 'aria-expanded': true })
    expect(expandedButton.props['aria-label']).toBe('Collapse repo worktree /repo')

    act(() => renderer.unmount())
    act(() => expandedRenderer.unmount())
  })

  test('collapse control toggles the group by stable worktree id', () => {
    const toggled: string[] = []
    const renderer = renderHeader(makeGroup(), (worktreeId) => toggled.push(worktreeId))
    const button = renderer.root.findByProps({ 'aria-expanded': true })

    act(() => {
      button.props.onClick()
    })
    expect(toggled).toEqual(['/repo/.git::/repo'])

    act(() => renderer.unmount())
  })

  test('hidden permission sessions surface through the attention badge', () => {
    const renderer = renderHeader(
      makeGroup({ attentionCount: 1, hiddenAttentionCount: 2, collapsed: true })
    )
    const header = headerByTestId(renderer)
    expect(header.props['data-attention-count']).toBe(3)
    expect(header.props['data-hidden-attention-count']).toBe(2)

    const badge = renderer.root.findByProps({ 'data-testid': 'worktree-attention-badge' })
    expect(badge.props['aria-label']).toBe('3 session(s) need permission')

    act(() => renderer.unmount())
  })

  test('no attention badge renders when nothing needs permission', () => {
    const renderer = renderHeader(makeGroup())
    const badges = renderer.root.findAllByProps({ 'data-testid': 'worktree-attention-badge' })
    expect(badges).toHaveLength(0)
    act(() => renderer.unmount())
  })

  test('active OpenSpec changes surface as a count badge', () => {
    const renderer = renderHeader(
      makeGroup({
        openspec: {
          changes: [
            { name: 'add-auth', status: 'in-progress' },
            { name: 'fix-nav' },
          ],
          stale: false,
        },
      })
    )
    const header = headerByTestId(renderer)
    expect(header.props['data-openspec-count']).toBe(2)

    const badge = renderer.root.findByProps({ 'data-testid': 'worktree-openspec-count' })
    expect(badge.props['aria-label']).toBe('2 active OpenSpec changes')

    act(() => renderer.unmount())
  })

  test('linked worktree shows its path leaf; main worktree omits the redundant leaf', () => {
    const linked = renderHeader(
      makeGroup({ worktreePath: '/code/repo-feature', branch: 'feature' })
    )
    const linkedLeaf = linked.root.findAllByProps({ title: '/code/repo-feature' })
    // Button title plus the visible path-leaf span.
    expect(linkedLeaf).toHaveLength(2)

    const main = renderHeader(makeGroup({ worktreePath: '/code/repo' }))
    const repoSpans = main.root
      .findAllByType('span')
      .filter((span) => span.props.children === 'repo')
    // Only the repository-name span; no redundant path leaf for the main worktree.
    expect(repoSpans).toHaveLength(1)
    expect(repoSpans[0].props.className).toContain('font-semibold')

    act(() => linked.unmount())
    act(() => main.unmount())
  })

  test('trailing actions slot renders custom controls', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <WorktreeGroupHeader
          group={makeGroup()}
          onToggleCollapse={() => {}}
          actions={<button type="button" data-testid="header-action">New</button>}
        />
      )
    })
    const action = renderer.root.findByProps({ 'data-testid': 'header-action' })
    expect(action.props.children).toBe('New')
    act(() => renderer.unmount())
  })
})
