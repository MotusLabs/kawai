import { describe, expect, test } from 'bun:test'
import type { WorkspaceRepository, WorkspaceWorktree } from '@shared/workspace'
import { brandLabels, contextName } from '../utils/contextName'

// Tables C and B of chat-context-name/design.md, verbatim.
const worktree = (path: string, isMain: boolean): WorkspaceWorktree => ({
  id: path, repositoryId: path, path, headRevision: 'abc', detached: false, isMain, dirty: false,
  openspec: { state: 'absent' } as unknown as WorkspaceWorktree['openspec'],
})

const repository = (name: string, worktrees: WorkspaceWorktree[]): WorkspaceRepository => ({
  id: name, name, commonDir: `${worktrees[0]!.path}/.git`, worktrees, branches: [], stale: false,
})

const repositories: WorkspaceRepository[] = [
  repository('kawai', [worktree('/home/coder/kawai', true), worktree('/home/coder/kawai/.worktrees/adopt', false)]),
  repository('outer', [worktree('/p/outer', true)]),
  repository('inner', [worktree('/p/outer/vendor/inner', true)]),
  // Display name deliberately unlike the checkout basename (design, Acceptance oracles).
  repository('Manga Studio 日本', [worktree('/projects/manga', true)]),
]

type Row = readonly [oracle: string, teamKey: string | null, path: string | null, remote: boolean, repos: WorkspaceRepository[] | null, expected: string | null]

const tableC: readonly Row[] = [
  ['C1', '/home/coder/kawai', '/projects/manga', true, repositories, 'kawai'],
  ['C1b', '/projects/manga', '/home/coder/kawai', false, repositories, 'Manga Studio 日本'],
  ['C2', '/projects/plain', '/home/coder/kawai', false, repositories, 'plain'],
  ['C3', '/projects/manga', '/home/coder/kawai', false, repositories, 'Manga Studio 日本'],
  ['C4', null, '/home/coder/kawai/.worktrees/adopt/src', false, repositories, 'kawai'],
  ['C5', null, '/home/coder/kawai', false, repositories, 'kawai'],
  ['C6', null, '/home/coder/kawai-notes', false, repositories, 'kawai-notes'],
  ['C7', null, '/home/coder/kawai/.worktrees/adopt', true, repositories, 'adopt'],
  ['C7b', null, '/projects/manga', true, repositories, 'manga'],
  ['C8', null, '/home/coder/kawai/.worktrees/adopt', false, null, 'adopt'],
  ['C9', null, '/p/outer/vendor/inner/x', false, repositories, 'inner'],
  ['C10', null, '/p/outer/src', false, repositories, 'outer'],
  ['C11', null, '/projects/Anime Studio 日本/', false, repositories, 'Anime Studio 日本'],
  ['C12', null, '/projects/manga/x', false, repositories, 'Manga Studio 日本'],
  ['C13', null, '/', false, repositories, null],
  ['C14', null, null, false, repositories, null],
]

const run = ([, teamKey, path, remote, repos]: Row) =>
  contextName({ teamKey, session: path === null ? null : { projectPath: path, remote }, repositories: repos })

describe('contextName (table C)', () => {
  for (const row of tableC) {
    const [oracle, , , , , expected] = row
    test(`${oracle}: context name is ${String(expected)}`, () => {
      expect(run(row)).toBe(expected)
    })
  }

  // C4 for a linked worktree, C6 for a prefix sibling, C7 for a remote path
  // a local lookup would name `kawai`, C1b/C3 for a Team route outranking the
  // session with a repository name unlike its basename, C2 for a plain
  // directory, C14 for no selection.
  const find = (oracle: string) => tableC.find(row => row[0] === oracle)!
  // @covers: workspace-navigation › The current context names its repository › A linked worktree names its repository
  test('C4 a linked worktree subdirectory names its repository', () => {
    expect(run(find('C4'))).toBe('kawai')
  })
  // @covers: workspace-navigation › The current context names its repository › A sibling path is not inside a worktree by prefix
  test('C6 a prefix sibling of a worktree uses its own directory name', () => {
    expect(run(find('C6'))).toBe('kawai-notes')
  })
  // @covers: workspace-navigation › The current context names its repository › A remote session uses its directory name
  test('C7 a remote session at a local worktree path uses its directory name', () => {
    expect(run(find('C7'))).toBe('adopt')
    expect(run(find('C7b'))).toBe('manga')
  })
  // @covers: workspace-navigation › The current context names its repository › A Team page names the team's repository
  test('C1b/C3 a Team route names its repository over the selected session', () => {
    expect(run(find('C1b'))).toBe('Manga Studio 日本')
    expect(run(find('C3'))).toBe('Manga Studio 日本')
  })
  // @covers: workspace-navigation › The current context names its repository › A plain-directory Team page uses its directory name
  test('C2 a plain-directory Team route uses its directory name', () => {
    expect(run(find('C2'))).toBe('plain')
  })
  // @covers: workspace-navigation › The current context names its repository › Nothing selected has no context name
  test('C14 nothing selected has no context name', () => {
    expect(run(find('C14'))).toBeNull()
  })
})

const tableB = [
  ['B1', 'kawai', 'anime-studio', 'kawai', 'kawai - Kawai'],
  ['B2', null, 'anime-studio', 'anime-studio', 'anime-studio - Kawai'],
  ['B3', null, null, 'KAWAI', 'Kawai'],
  ['B4', 'kawai', null, 'kawai', 'kawai - Kawai'],
] as const

describe('brandLabels (table B)', () => {
  for (const [oracle, context, workspace, heading, title] of tableB) {
    test(`${oracle}: heading ${heading}, title ${title}`, () => {
      expect(brandLabels(context, workspace)).toEqual({ heading, title })
    })
  }
})
