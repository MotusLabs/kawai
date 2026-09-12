// BranchBrowserModal.test.tsx - Task 8.1 coverage: repository branch browser
// lists local branches with their assigned worktrees; creation is enabled
// only for unassigned branches (assigned rows identify their worktree and
// keep the duplicate action disabled). Covers assigned, unassigned,
// detached-worktree, empty, and filtered branch lists plus accessibility.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkspaceBranch, WorkspaceRepository } from '@shared/workspace'
import BranchBrowserModal from '../components/BranchBrowserModal'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
}

const originalWindow = globalAny.window

function makeBranch(name: string, assignedWorktreeId?: string): WorkspaceBranch {
  return {
    name,
    revision: `${name.repeat(7).slice(0, 7)}aaaaaa1`.slice(0, 40),
    ...(assignedWorktreeId !== undefined ? { assignedWorktreeId } : {}),
  }
}

function makeRepository(overrides: Partial<WorkspaceRepository> = {}): WorkspaceRepository {
  return {
    id: '/repo/.git',
    name: 'repo',
    commonDir: '/repo/.git',
    stale: false,
    worktrees: [
      {
        id: '/repo/.git::/repo',
        repositoryId: '/repo/.git',
        path: '/repo',
        branch: 'main',
        headRevision: 'aaaaaaa1aaaaaaa1',
        detached: false,
        isMain: true,
        dirty: false,
        openspec: { changes: [], stale: false },
      },
      {
        id: '/repo/.git::/repo-feature',
        repositoryId: '/repo/.git',
        path: '/repo-feature',
        branch: 'feature',
        headRevision: 'bbbbbbb2bbbbbbb2',
        detached: false,
        isMain: false,
        dirty: false,
        openspec: { changes: [], stale: false },
      },
    ],
    branches: [
      makeBranch('main', '/repo/.git::/repo'),
      makeBranch('feature', '/repo/.git::/repo-feature'),
      makeBranch('spare-x'),
    ],
    ...overrides,
  }
}

function renderBrowser(
  repository: WorkspaceRepository,
  onCreateWorktree: (branch: WorkspaceBranch) => void = () => {}
) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <BranchBrowserModal
        repository={repository}
        onClose={() => {}}
        onCreateWorktree={onCreateWorktree}
      />
    )
  })
  return renderer
}

function branchRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByProps({ 'data-testid': 'branch-row' })
}

beforeAll(() => {
  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis
})

afterAll(() => {
  globalAny.window = originalWindow
})

describe('BranchBrowserModal', () => {
  test('lists branches with assigned worktrees identified and creation disabled', () => {
    const renderer = renderBrowser(makeRepository())
    const rows = branchRows(renderer)
    expect(rows.map((row) => row.props['data-branch'])).toEqual(['main', 'feature', 'spare-x'])

    // main -> assigned to /repo; feature -> assigned to /repo-feature.
    expect(rows[0].props['data-assigned']).toBe('true')
    expect(rows[1].props['data-assigned']).toBe('true')

    // The assigned rows name their worktree in the label and title.
    const mainCreate = rows[0].findByProps({ 'data-testid': 'branch-create' })
    expect(mainCreate.props.disabled).toBe(true)
    expect(mainCreate.props['aria-disabled']).toBe('true')
    expect(mainCreate.props['aria-label']).toBe(
      'Branch main is checked out at /repo'
    )
    expect(mainCreate.props.title).toBe('Checked out at /repo')

    // The visible assignment names the worktree path leaf.
    const assignment = rows[0].findByProps({ title: '/repo' })
    expect(assignment.props.children).toEqual(['in ', 'repo'])

    const featureCreate = rows[1].findByProps({ 'data-testid': 'branch-create' })
    expect(featureCreate.props['aria-label']).toBe(
      'Branch feature is checked out at /repo-feature'
    )

    act(() => renderer.unmount())
  })

  test('unassigned branches enable creation and report the exact branch', () => {
    const created: string[] = []
    const renderer = renderBrowser(makeRepository(), (branch) => created.push(branch.name))

    const spareRow = branchRows(renderer).find(
      (row) => row.props['data-branch'] === 'spare-x'
    )
    if (!spareRow) throw new Error('Expected spare-x row')
    expect(spareRow.props['data-assigned']).toBe('false')

    const create = spareRow.findByProps({ 'data-testid': 'branch-create' })
    expect(create.props.disabled).toBe(false)
    expect(create.props['aria-disabled']).toBeUndefined()
    expect(create.props['aria-label']).toBe('Create worktree for branch spare-x')
    act(() => {
      create.props.onClick()
    })
    expect(created).toEqual(['spare-x'])

    act(() => renderer.unmount())
  })

  test('a detached worktree assigns no branch, so every branch stays creatable', () => {
    const repository = makeRepository({
      worktrees: [
        {
          id: '/repo/.git::/repo',
          repositoryId: '/repo/.git',
          path: '/repo',
          headRevision: 'ccccccc3ccccccc3',
          detached: true,
          isMain: true,
          dirty: false,
          openspec: { changes: [], stale: false },
        },
      ],
      branches: [makeBranch('main'), makeBranch('spare-x')],
    })
    const created: string[] = []
    const renderer = renderBrowser(repository, (branch) => created.push(branch.name))

    const rows = branchRows(renderer)
    expect(rows.map((row) => row.props['data-assigned'])).toEqual(['false', 'false'])
    for (const row of rows) {
      const create = row.findByProps({ 'data-testid': 'branch-create' })
      expect(create.props.disabled).toBe(false)
    }

    act(() => {
      rows[1].findByProps({ 'data-testid': 'branch-create' }).props.onClick()
    })
    expect(created).toEqual(['spare-x'])

    act(() => renderer.unmount())
  })

  test('repository without local branches shows the empty state', () => {
    const renderer = renderBrowser(makeRepository({ branches: [] }))

    expect(branchRows(renderer)).toHaveLength(0)
    expect(
      renderer.root.findByProps({ 'data-testid': 'branch-empty' }).props.children
    ).toBe('No local branches')
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'branch-no-match' })
    ).toHaveLength(0)

    act(() => renderer.unmount())
  })

  test('filter narrows the branch list and reports unmatched filters', () => {
    const renderer = renderBrowser(makeRepository())
    const filter = renderer.root.findByProps({ 'data-testid': 'branch-filter' })
    expect(filter.props['aria-label']).toBe('Filter branches')

    act(() => {
      filter.props.onChange({ target: { value: 'spar' } })
    })
    expect(branchRows(renderer).map((row) => row.props['data-branch'])).toEqual(['spare-x'])
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'branch-no-match' })
    ).toHaveLength(0)

    act(() => {
      filter.props.onChange({ target: { value: 'nope' } })
    })
    expect(branchRows(renderer)).toHaveLength(0)
    expect(
      renderer.root.findByProps({ 'data-testid': 'branch-no-match' }).props.children
    ).toContain('nope')

    act(() => renderer.unmount())
  })

  test('dialog exposes accessible roles and labels', () => {
    const renderer = renderBrowser(makeRepository())
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props['aria-modal']).toBe('true')
    expect(dialog.props['aria-labelledby']).toBe('branch-browser-title')

    const list = renderer.root.findByProps({ 'data-testid': 'branch-list' })
    expect(list.props['aria-label']).toBe('Local branches in repo')
    expect(list.props.role).toBe('list')

    act(() => renderer.unmount())
  })
})
