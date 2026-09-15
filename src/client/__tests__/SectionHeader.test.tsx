// SectionHeader.test.tsx - Task 6.1/6.4 coverage: section header states —
// change sections (canonical progress, missing-in-worktree, repository
// context, stale) and worktree sections (clean, dirty, detached, stale,
// collapsed, hidden permission, counts, collapse control, accessible labels,
// and the trailing actions slot).
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChangeRegistryEntry } from '@shared/workspace'
import {
  type ChangeSectionData,
  type WorktreeSectionData,
} from '../utils/workspaceView'
import SectionHeader from '../components/SectionHeader'

function makeWorktreeSection(overrides: Partial<WorktreeSectionData> = {}): WorktreeSectionData {
  return {
    kind: 'worktree',
    key: '/repo/.git::/repo',
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
    collapsed: false,
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
    ...overrides,
  }
}

function makeChangeSection(
  change: Partial<ChangeRegistryEntry> = {},
  overrides: Partial<ChangeSectionData> = {}
): ChangeSectionData {
  return {
    kind: 'change',
    key: '/repo/.git::change::add-auth',
    repositoryId: '/repo/.git',
    repositoryName: 'repo',
    repositoryStale: false,
    change: {
      name: 'add-auth',
      source: 'worktree',
      worktreeId: '/repo/.git::/repo/.worktrees/add-auth',
      worktreePath: '/repo/.worktrees/add-auth',
      completedTasks: 9,
      totalTasks: 11,
      ...change,
    },
    collapsed: false,
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
    ...overrides,
  }
}

function renderHeader(
  section: ChangeSectionData | WorktreeSectionData,
  onToggleCollapse: (sectionKey: string) => void = () => {}
) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <SectionHeader section={section} onToggleCollapse={onToggleCollapse} />
    )
  })
  return renderer
}

function headerRoot(renderer: TestRenderer.ReactTestRenderer) {
  const header = renderer.root.findByProps({ 'data-testid': 'section-header' })
  if (!header) throw new Error('Expected section header')
  return header
}

function collapseButton(renderer: TestRenderer.ReactTestRenderer, expanded = true) {
  return headerRoot(renderer).findByProps({ 'aria-expanded': expanded })
}

describe('SectionHeader worktree sections', () => {
  test('clean worktree shows repository, branch, and counts without state badges', () => {
    const renderer = renderHeader(
      makeWorktreeSection({ entries: [{ key: 's1', kind: 'live' }] })
    )
    const header = headerRoot(renderer)
    expect(header.props['data-section-kind']).toBe('worktree')
    expect(header.props['data-session-count']).toBe(1)
    expect(collapseButton(renderer).props.title).toBe('/repo')
    expect(renderer.root.findAllByProps({ 'data-testid': 'section-attention-badge' })).toHaveLength(0)
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('repo')
    expect(json).toContain('main')
  })

  test('dirty, detached, and stale worktrees surface state badges', () => {
    const detached = renderHeader(
      makeWorktreeSection({
        branch: undefined,
        detached: true,
        dirty: true,
        headRevision: 'ccccccc3ccccccc3',
        repositoryStale: true,
        repositoryError: 'git failed',
      })
    )
    const json = JSON.stringify(detached.toJSON())
    expect(json).toContain('dirty')
    expect(json).toContain('stale')
    expect(json).toContain('detached')
    expect(json).toContain('@ccccccc')
  })

  test('hidden permission counts surface even when rows are invisible', () => {
    const renderer = renderHeader(makeWorktreeSection({ hiddenAttentionCount: 2 }))
    const badge = renderer.root.findByProps({ 'data-testid': 'section-attention-badge' })
    expect(badge.props['aria-label']).toBe('2 session(s) need permission')
    expect(headerRoot(renderer).props['data-attention-count']).toBe(2)
  })

  test('collapse control reports the section key and expanded state', () => {
    const toggles: string[] = []
    const renderer = renderHeader(makeWorktreeSection(), (key) => toggles.push(key))
    const button = collapseButton(renderer)
    expect(button.props['aria-label']).toBe('Collapse repo worktree /repo')
    act(() => button.props.onClick())
    expect(toggles).toEqual(['/repo/.git::/repo'])

    const collapsed = renderHeader(makeWorktreeSection({ collapsed: true }))
    expect(collapseButton(collapsed, false).props['aria-label']).toBe('Expand repo worktree /repo')
    expect(collapseButton(collapsed, false).props['aria-expanded']).toBe(false)
  })
})

describe('SectionHeader change sections', () => {
  test('shows the change name, canonical progress, and repository context', () => {
    const renderer = renderHeader(makeChangeSection())
    const header = headerRoot(renderer)
    expect(header.props['data-section-kind']).toBe('change')
    expect(String(renderer.root.findByProps({ 'data-testid': 'change-name' }).children)).toContain('add-auth')
    expect(renderer.root.findByProps({ 'data-testid': 'change-progress' }).children.join('')).toBe('9/11')
    expect(JSON.stringify(renderer.toJSON())).toContain('repo')
  })

  test('omits the progress badge when counts are unavailable', () => {
    const renderer = renderHeader(
      makeChangeSection({ completedTasks: undefined, totalTasks: undefined, source: 'registry' })
    )
    expect(renderer.root.findAllByProps({ 'data-testid': 'change-progress' })).toHaveLength(0)
    expect(String(renderer.root.findByProps({ 'data-testid': 'change-name' }).children)).toContain('add-auth')
  })

  test('flags a change missing from its worktree', () => {
    const renderer = renderHeader(
      makeChangeSection({ source: 'registry', missingInWorktree: true, completedTasks: undefined, totalTasks: undefined })
    )
    const badge = renderer.root.findByProps({ 'data-testid': 'change-missing-in-worktree' })
    expect(badge.children).toContain('not in worktree')
  })

  test('stale repository context shows a badge without hiding the change', () => {
    const renderer = renderHeader(
      makeChangeSection({}, { repositoryStale: true, repositoryError: 'openspec failed' })
    )
    expect(JSON.stringify(renderer.toJSON())).toContain('stale')
    expect(String(renderer.root.findByProps({ 'data-testid': 'change-name' }).children)).toContain('add-auth')
  })

  test('collapsed change section hides nothing in the header and reports the key', () => {
    const toggles: string[] = []
    const renderer = renderHeader(
      makeChangeSection(
        { worktreePath: undefined, worktreeId: undefined, source: 'registry' },
        { collapsed: true }
      ),
      (key) => toggles.push(key)
    )
    const button = renderer.root.findByProps({ 'aria-expanded': false })
    expect(button.props['aria-label']).toBe('Expand change add-auth in repo')
    expect(button.props.title).toBe('repo: add-auth')
    act(() => button.props.onClick())
    expect(toggles).toEqual(['/repo/.git::change::add-auth'])
  })

  test('actions slot renders at the trailing edge', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SectionHeader
          section={makeChangeSection()}
          onToggleCollapse={() => {}}
          actions={<button data-testid="trailing-action">+</button>}
        />
      )
    })
    expect(renderer.root.findByProps({ 'data-testid': 'trailing-action' })).toBeTruthy()
  })
})
