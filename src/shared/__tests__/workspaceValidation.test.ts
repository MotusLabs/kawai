import { describe, expect, test } from 'bun:test'
import {
  isAbsoluteLocalPath,
  isValidGitRefName,
  parseCreateWorktreePayload,
  parseWorkspaceSnapshot,
} from '../workspaceValidation'

const validSnapshot = {
  repositories: [
    {
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
          headRevision: '0123456789abcdef',
          detached: false,
          isMain: true,
          dirty: true,
          openspec: {
            rootPath: '/repo/openspec',
            changes: [
              {
                name: 'add-auth',
                status: 'in-progress',
                completedTasks: 2,
                totalTasks: 5,
                lastModified: '2026-01-01T00:00:00.000Z',
              },
            ],
            stale: false,
          },
        },
      ],
      branches: [{ name: 'main', revision: '0123456789abcdef', assignedWorktreeId: '/repo/.git::/repo' }],
    },
  ],
  generatedAt: '2026-01-01T00:00:00.000Z',
}

describe('parseWorkspaceSnapshot', () => {
  test('parses a fully populated snapshot', () => {
    const parsed = parseWorkspaceSnapshot(validSnapshot)
    expect(parsed).not.toBeNull()
    expect(parsed?.repositories).toHaveLength(1)
    expect(parsed?.repositories[0].worktrees[0].branch).toBe('main')
    expect(parsed?.repositories[0].worktrees[0].openspec.changes[0].name).toBe('add-auth')
    expect(parsed?.repositories[0].branches[0].assignedWorktreeId).toBe('/repo/.git::/repo')
  })

  test('tolerates backward-compatible payloads without optional fields', () => {
    const parsed = parseWorkspaceSnapshot({
      repositories: [
        {
          id: '/repo/.git',
          name: 'repo',
          commonDir: '/repo/.git',
          worktrees: [
            {
              id: '/repo/.git::/repo',
              repositoryId: '/repo/.git',
              path: '/repo',
              headRevision: '0123456',
              detached: true,
              isMain: true,
              dirty: false,
            },
          ],
          branches: [],
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(parsed).not.toBeNull()
    const worktree = parsed?.repositories[0].worktrees[0]
    expect(worktree?.branch).toBeUndefined()
    expect(worktree?.detached).toBe(true)
    // Missing openspec field defaults to a non-error empty state.
    expect(worktree?.openspec).toEqual({ changes: [], stale: false })
  })

  test('drops malformed repository entries while keeping valid ones', () => {
    const parsed = parseWorkspaceSnapshot({
      repositories: [
        'garbage',
        { id: '/repo/.git', name: 'repo', commonDir: '/repo/.git', worktrees: [], branches: [] },
        { id: '', name: 'empty-id', commonDir: '/repo/.git', worktrees: [], branches: [] },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(parsed?.repositories).toHaveLength(1)
    expect(parsed?.repositories[0].name).toBe('repo')
  })

  test('drops malformed worktrees and branches inside a repository', () => {
    const parsed = parseWorkspaceSnapshot({
      repositories: [
        {
          id: '/repo/.git',
          name: 'repo',
          commonDir: '/repo/.git',
          worktrees: [{ id: 'wt', repositoryId: 'r', path: '/repo' }, { id: 'wt2', repositoryId: 'r', path: '/repo-2', headRevision: 'abc' }],
          branches: [42, { name: 'ok', revision: 'abc' }, { name: '', revision: 'abc' }],
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(parsed?.repositories[0].worktrees).toHaveLength(1)
    expect(parsed?.repositories[0].branches).toHaveLength(1)
    expect(parsed?.repositories[0].branches[0].name).toBe('ok')
  })

  test('drops malformed openspec changes and ignores non-integer counts', () => {
    const parsed = parseWorkspaceSnapshot({
      repositories: [
        {
          id: '/repo/.git',
          name: 'repo',
          commonDir: '/repo/.git',
          worktrees: [
            {
              id: 'wt',
              repositoryId: '/repo/.git',
              path: '/repo',
              headRevision: 'abc',
              detached: false,
              isMain: true,
              dirty: false,
              openspec: {
                changes: [{ name: 'ok' }, { nope: true }, { name: 'bad-count', completedTasks: 'many', totalTasks: -1 }],
                stale: 'yes',
              },
            },
          ],
          branches: [],
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    const openspec = parsed?.repositories[0].worktrees[0].openspec
    expect(openspec?.changes).toHaveLength(2)
    expect(openspec?.changes[0]).toEqual({ name: 'ok' })
    expect(openspec?.changes[1]).toEqual({ name: 'bad-count' })
    expect(openspec?.stale).toBe(false)
  })

  test('returns null for malformed top-level payloads', () => {
    expect(parseWorkspaceSnapshot(null)).toBeNull()
    expect(parseWorkspaceSnapshot('nope')).toBeNull()
    expect(parseWorkspaceSnapshot({})).toBeNull()
    expect(parseWorkspaceSnapshot({ repositories: 'nope' })).toBeNull()
    expect(parseWorkspaceSnapshot({ repositories: [] })).toBeNull()
    expect(parseWorkspaceSnapshot({ repositories: [], generatedAt: '' })).toBeNull()
  })
})

describe('isValidGitRefName', () => {
  test('accepts ordinary branch names', () => {
    expect(isValidGitRefName('main')).toBe(true)
    expect(isValidGitRefName('feature/add-auth')).toBe(true)
    expect(isValidGitRefName('v1.2.3')).toBe(true)
    expect(isValidGitRefName('users/ruslan/fix')).toBe(true)
  })

  test('rejects invalid or unsafe branch names', () => {
    expect(isValidGitRefName('')).toBe(false)
    expect(isValidGitRefName('-started-with-dash')).toBe(false)
    expect(isValidGitRefName('.hidden')).toBe(false)
    expect(isValidGitRefName('contains..dots')).toBe(false)
    expect(isValidGitRefName('ends/')).toBe(false)
    expect(isValidGitRefName('ends.')).toBe(false)
    expect(isValidGitRefName('branch.lock')).toBe(false)
    expect(isValidGitRefName('has space')).toBe(false)
    expect(isValidGitRefName('has~tilde')).toBe(false)
    expect(isValidGitRefName('has^caret')).toBe(false)
    expect(isValidGitRefName('has:colon')).toBe(false)
    expect(isValidGitRefName('has*star')).toBe(false)
    expect(isValidGitRefName('has@{brace')).toBe(false)
    expect(isValidGitRefName('a'.repeat(5000))).toBe(false)
  })
})

describe('isAbsoluteLocalPath', () => {
  test('accepts absolute paths', () => {
    expect(isAbsoluteLocalPath('/repo')).toBe(true)
    expect(isAbsoluteLocalPath('/home/user/work trees/x')).toBe(true)
  })

  test('rejects relative, empty, and oversized paths', () => {
    expect(isAbsoluteLocalPath('repo')).toBe(false)
    expect(isAbsoluteLocalPath('./repo')).toBe(false)
    expect(isAbsoluteLocalPath('')).toBe(false)
    expect(isAbsoluteLocalPath('/')).toBe(false)
    expect(isAbsoluteLocalPath('/' + 'a'.repeat(5000))).toBe(false)
  })
})

describe('parseCreateWorktreePayload', () => {
  test('parses a valid request with optional launch flag', () => {
    expect(
      parseCreateWorktreePayload({
        repositoryId: '/repo/.git',
        branch: 'feat/x',
        destination: '/repo-feat',
        launchSession: true,
      })
    ).toEqual({ repositoryId: '/repo/.git', branch: 'feat/x', destination: '/repo-feat', launchSession: true })
  })

  test('omits launchSession when absent or false', () => {
    expect(
      parseCreateWorktreePayload({ repositoryId: '/repo/.git', branch: 'feat', destination: '/repo-feat' })
    ).toEqual({ repositoryId: '/repo/.git', branch: 'feat', destination: '/repo-feat' })
    expect(
      parseCreateWorktreePayload({ repositoryId: '/repo/.git', branch: 'feat', destination: '/repo-feat', launchSession: false })
    ).toEqual({ repositoryId: '/repo/.git', branch: 'feat', destination: '/repo-feat' })
  })

  test('rejects malformed payloads', () => {
    expect(parseCreateWorktreePayload(null)).toBeNull()
    expect(parseCreateWorktreePayload('nope')).toBeNull()
    expect(parseCreateWorktreePayload({})).toBeNull()
    expect(parseCreateWorktreePayload({ repositoryId: '', branch: 'feat', destination: '/w' })).toBeNull()
    expect(parseCreateWorktreePayload({ repositoryId: '/r/.git', branch: '', destination: '/w' })).toBeNull()
    // Relative destinations are rejected.
    expect(parseCreateWorktreePayload({ repositoryId: '/r/.git', branch: 'feat', destination: 'repo-feat' })).toBeNull()
    // Invalid ref names are rejected.
    expect(parseCreateWorktreePayload({ repositoryId: '/r/.git', branch: 'bad..name', destination: '/w' })).toBeNull()
    expect(parseCreateWorktreePayload({ repositoryId: '/r/.git', branch: 'main', destination: '' })).toBeNull()
  })
})
