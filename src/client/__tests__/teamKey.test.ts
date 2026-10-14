import { describe, expect, test } from 'bun:test'
import type { WorkspaceRepository, WorkspaceWorktree } from '@shared/workspace'
import { teamKeyOf } from '../utils/teamKey'

const worktree = (path: string, isMain: boolean): WorkspaceWorktree => ({
  id: path, repositoryId: 'repo', path, headRevision: 'abc', detached: false, isMain, dirty: false,
  openspec: { state: 'absent' } as unknown as WorkspaceWorktree['openspec'],
})

const repository = (commonDir: string, worktrees: WorkspaceWorktree[]): WorkspaceRepository => ({
  id: commonDir, name: 'repo', commonDir, worktrees, branches: [], stale: false,
})

const kawai = repository('/home/coder/kawai/.git', [
  worktree('/home/coder/kawai', true),
  worktree('/home/coder/kawai/.worktrees/feature', false),
])
const other = repository('/home/coder/other/.git', [worktree('/home/coder/other', true)])

describe('teamKeyOf', () => {
  test('a worktree chat and the main checkout share the repository key', () => {
    expect(teamKeyOf('/home/coder/kawai', [kawai, other])).toBe('/home/coder/kawai')
    expect(teamKeyOf('/home/coder/kawai/.worktrees/feature', [kawai, other])).toBe('/home/coder/kawai')
  })

  test('a subdirectory maps through its deepest enclosing worktree', () => {
    expect(teamKeyOf('/home/coder/kawai/.worktrees/feature/src', [kawai])).toBe('/home/coder/kawai')
    expect(teamKeyOf('/home/coder/kawai/src/', [kawai])).toBe('/home/coder/kawai')
  })

  test('a path outside every repository keys by its own directory', () => {
    expect(teamKeyOf('/tmp/notes/', [kawai])).toBe('/tmp/notes')
    expect(teamKeyOf('/home/coder/kawai-other', [kawai])).toBe('/home/coder/kawai-other')
    expect(teamKeyOf('/tmp/notes', null)).toBe('/tmp/notes')
  })

  test('a bare repository without a main worktree keys by its first worktree path', () => {
    const bare = repository('/srv/bare.git', [worktree('/srv/wt-b', false), worktree('/srv/wt-a', false)])
    expect(teamKeyOf('/srv/wt-b', [bare])).toBe('/srv/wt-a')
  })
})
