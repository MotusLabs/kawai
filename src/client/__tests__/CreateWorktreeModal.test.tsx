// CreateWorktreeModal.test.tsx - Task 8.2 coverage: create-worktree form
// suggests a collision-resistant sibling destination, accepts path editing,
// validates absolute destinations, shows the exact branch/destination
// confirmation summary, supports cancellation, and carries the optional
// follow-up session launch choice.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkspaceBranch, WorkspaceRepository } from '@shared/workspace'
import CreateWorktreeModal from '../components/CreateWorktreeModal'
import {
  sanitizeBranchForPath,
  suggestWorktreeDestination,
} from '../utils/worktreeDestination'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
}

const originalWindow = globalAny.window

const branch: WorkspaceBranch = { name: 'feat/auth-x', revision: 'bbbbbbb2bbbbbbb2' }

const repository: WorkspaceRepository = {
  id: '/code/repo/.git',
  name: 'repo',
  commonDir: '/code/repo/.git',
  stale: false,
  worktrees: [
    {
      id: '/code/repo/.git::/code/repo',
      repositoryId: '/code/repo/.git',
      path: '/code/repo',
      branch: 'main',
      headRevision: 'aaaaaaa1aaaaaaa1',
      detached: false,
      isMain: true,
      dirty: false,
      openspec: { changes: [], stale: false },
    },
    {
      id: '/code/repo/.git::/code/repo-existing',
      repositoryId: '/code/repo/.git',
      path: '/code/repo-existing',
      branch: 'existing',
      headRevision: 'ccccccc3ccccccc3',
      detached: false,
      isMain: false,
      dirty: false,
      openspec: { changes: [], stale: false },
    },
  ],
  branches: [],
}

function renderForm(
  overrides: {
    existingWorktreePaths?: string[]
    onConfirm?: (destination: string, launchSession: boolean) => void
    onCancel?: () => void
  } = {}
) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <CreateWorktreeModal
        repository={repository}
        branch={branch}
        existingWorktreePaths={
          overrides.existingWorktreePaths ?? [
            '/code/repo',
            '/code/repo-existing',
            '/elsewhere/other',
          ]
        }
        onConfirm={overrides.onConfirm ?? (() => {})}
        onCancel={overrides.onCancel ?? (() => {})}
      />
    )
  })
  return renderer
}

function destinationInput(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ 'data-testid': 'create-worktree-destination' })
}

function submitButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ 'data-testid': 'create-worktree-submit' })
}

function summaryText(renderer: TestRenderer.ReactTestRenderer): string {
  const summary = renderer.root.findByProps({ 'data-testid': 'create-worktree-summary' })
  const collect = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(collect).join('')
    if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
      return collect((node as { props: { children?: unknown } }).props.children)
    }
    return ''
  }
  return collect(summary)
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

describe('worktree destination suggestion', () => {
  test('sanitizes branch names into a single safe path segment', () => {
    expect(sanitizeBranchForPath('feat/auth-x')).toBe('feat-auth-x')
    expect(sanitizeBranchForPath('bugfix/very///deep.name')).toBe('bugfix-very-deep.name')
    expect(sanitizeBranchForPath('spaces and $ymbols')).toBe('spaces-and-ymbols')
    expect(sanitizeBranchForPath('///')).toBe('worktree')
  })

  test('suggests a sibling of the main worktree and avoids known collisions', () => {
    expect(
      suggestWorktreeDestination('/code/repo', 'repo', 'feat/auth-x', [
        '/code/repo',
        '/elsewhere/other',
      ])
    ).toBe('/code/repo-feat-auth-x')

    // Colliding candidate rolls to -2, -3, …
    expect(
      suggestWorktreeDestination('/code/repo', 'repo', 'feat/auth-x', [
        '/code/repo',
        '/code/repo-feat-auth-x',
      ])
    ).toBe('/code/repo-feat-auth-x-2')
    expect(
      suggestWorktreeDestination('/code/repo', 'repo', 'feat/auth-x', [
        '/code/repo',
        '/code/repo-feat-auth-x',
        '/code/repo-feat-auth-x-2',
      ])
    ).toBe('/code/repo-feat-auth-x-3')
  })
})

describe('CreateWorktreeModal', () => {
  test('pre-fills a collision-resistant absolute suggestion and exact summary', () => {
    const renderer = renderForm()
    expect(destinationInput(renderer).props.value).toBe('/code/repo-feat-auth-x')

    const form = renderer.root.findByProps({ 'data-testid': 'create-worktree-form' })
    expect(form.props['data-branch']).toBe('feat/auth-x')

    // The summary states the exact branch and destination before confirmation.
    const summary = summaryText(renderer)
    expect(summary).toContain('feat/auth-x')
    expect(summary).toContain('/code/repo-feat-auth-x')
    expect(summary).toContain('repo')

    act(() => renderer.unmount())
  })

  test('destination editing flows into validation and the summary', () => {
    const confirmed: Array<{ destination: string; launchSession: boolean }> = []
    const renderer = renderForm({ onConfirm: (destination, launchSession) => confirmed.push({ destination, launchSession }) })

    // Relative paths are rejected with an inline error and disabled submit.
    act(() => {
      destinationInput(renderer).props.onChange({ target: { value: 'repo-feat' } })
    })
    expect(
      renderer.root.findByProps({ 'data-testid': 'create-worktree-destination-error' }).props.children
    ).toBe('Destination must be an absolute path')
    expect(destinationInput(renderer).props['aria-invalid']).toBe('true')
    expect(submitButton(renderer).props.disabled).toBe(true)
    expect(summaryText(renderer)).toContain('…')

    // Editing back to an absolute path re-enables submission.
    act(() => {
      destinationInput(renderer).props.onChange({ target: { value: '/code/edited-path ' } })
    })
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'create-worktree-destination-error' })
    ).toHaveLength(0)
    expect(submitButton(renderer).props.disabled).toBe(false)
    expect(summaryText(renderer)).toContain('/code/edited-path')

    // Submitting a valid form reports the trimmed destination exactly.
    act(() => {
      renderer.root
        .findByProps({ 'data-testid': 'create-worktree-form' })
        .props.onSubmit({ preventDefault: () => {} })
    })
    expect(confirmed).toEqual([{ destination: '/code/edited-path', launchSession: false }])

    act(() => renderer.unmount())
  })

  test('empty destination is invalid', () => {
    const renderer = renderForm()
    act(() => {
      destinationInput(renderer).props.onChange({ target: { value: '   ' } })
    })
    expect(
      renderer.root.findByProps({ 'data-testid': 'create-worktree-destination-error' }).props.children
    ).toBe('Destination is required')
    expect(submitButton(renderer).props.disabled).toBe(true)

    act(() => renderer.unmount())
  })

  test('cancellation reports back without confirming', () => {
    const confirmed: unknown[] = []
    const cancelled: number[] = []
    const renderer = renderForm({
      onConfirm: () => confirmed.push(true),
      onCancel: () => cancelled.push(1),
    })

    act(() => {
      renderer.root.findByProps({ 'data-testid': 'create-worktree-cancel' }).props.onClick()
    })
    expect(cancelled).toHaveLength(1)
    expect(confirmed).toHaveLength(0)

    act(() => renderer.unmount())
  })

  test('launch checkbox carries the follow-up session choice', () => {
    const confirmed: Array<{ destination: string; launchSession: boolean }> = []
    const renderer = renderForm({ onConfirm: (destination, launchSession) => confirmed.push({ destination, launchSession }) })

    const launch = renderer.root.findByProps({ 'data-testid': 'create-worktree-launch' })
    expect(launch.props.checked).toBe(false)
    expect(summaryText(renderer)).not.toContain('then open session options')

    act(() => {
      launch.props.onChange({ target: { checked: true } })
    })
    expect(
      renderer.root.findByProps({ 'data-testid': 'create-worktree-launch' }).props.checked
    ).toBe(true)
    expect(summaryText(renderer)).toContain('then open session options')

    act(() => {
      renderer.root
        .findByProps({ 'data-testid': 'create-worktree-form' })
        .props.onSubmit({ preventDefault: () => {} })
    })
    expect(confirmed).toEqual([{ destination: '/code/repo-feat-auth-x', launchSession: true }])

    act(() => renderer.unmount())
  })

  test('dialog exposes accessible roles and labels', () => {
    const renderer = renderForm()
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props['aria-modal']).toBe('true')
    expect(dialog.props['aria-labelledby']).toBe('create-worktree-title')

    const branchLabel = renderer.root.findByProps({ 'data-testid': 'create-worktree-branch' })
    expect(branchLabel.props.children).toBe('feat/auth-x')

    act(() => renderer.unmount())
  })
})
