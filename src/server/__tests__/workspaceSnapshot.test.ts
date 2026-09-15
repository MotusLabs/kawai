// workspaceSnapshot.test.ts - Task 2.4 coverage: deterministic repository
// snapshots assembled from live/hibernating/history/on-demand seeds, with
// per-repository failure isolation (empty worktrees, last-valid stale).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { buildWorkspaceSnapshot } from '../git/workspaceSnapshot'
import { canonicalizePath } from '../git/repositoryResolution'
import type { WorkspaceSnapshot } from '../../shared/workspace'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let tempRoot: string

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const init = runGit(['init', '--initial-branch=main', dir], { timeoutMs: 5000 })
  // Fail loudly when the fixture repo cannot be created: a silent failure
  // makes later rev-parse calls resolve the ambient repository and produces
  // misleading snapshot assertions far from the root cause.
  if (!init.ok) {
    throw new Error(`git init failed for ${dir}: ${init.stderr.trim()}`)
  }
  const commit = runGit(['-C', dir, 'commit', '--allow-empty', '-m', 'init'], {
    timeoutMs: 5000,
    env: COMMIT_ENV,
  })
  if (!commit.ok) {
    throw new Error(`git commit failed for ${dir}: ${commit.stderr.trim()}`)
  }
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-wssnap-'))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('buildWorkspaceSnapshot', () => {
  test('assembles repository, worktrees, and branches deterministically', () => {
    const repo = path.join(tempRoot, 'repo')
    const linked = path.join(tempRoot, 'repo-linked')
    gitInit(repo)
    runGit(['-C', repo, 'worktree', 'add', linked, '-b', 'feat'], { timeoutMs: 10_000 })

    const first = buildWorkspaceSnapshot([repo])
    const second = buildWorkspaceSnapshot([repo, path.join(repo, 'sub')])

    expect(first.repositories).toHaveLength(1)
    const repository = first.repositories[0]
    const canonical = canonicalizePath(repo)
    expect(repository.id).toBe(path.join(canonical, '.git'))
    expect(repository.name).toBe(path.basename(canonical))
    expect(repository.stale).toBe(false)

    const worktreePaths = repository.worktrees.map((worktree) => worktree.path)
    expect(worktreePaths).toEqual([canonical, canonicalizePath(linked)].sort())
    // Worktree without any session still appears (empty worktree display).
    const linkedWorktree = repository.worktrees.find(
      (worktree) => worktree.path === canonicalizePath(linked)
    )
    expect(linkedWorktree).toBeTruthy()
    expect(linkedWorktree?.branch).toBe('feat')
    expect(linkedWorktree?.openspec).toEqual({ changes: [], stale: false })

    const branchNames = repository.branches.map((branch) => branch.name)
    expect(branchNames).toEqual(['feat', 'main'])
    const featBranch = repository.branches.find((branch) => branch.name === 'feat')
    expect(featBranch?.assignedWorktreeId).toBe(linkedWorktree?.id)

    // Deterministic apart from generatedAt.
    expect(second.repositories[0]).toEqual({
      ...repository,
    })
  })

  test('merges duplicate seeds from live, hibernating, and history paths', () => {
    const repo = path.join(tempRoot, 'repo-dedupe')
    gitInit(repo)
    const snapshot = buildWorkspaceSnapshot([
      repo,                                        // live
      path.join(repo, 'src'),                     // hibernating beneath root
      repo,                                        // history duplicate
      path.join(tempRoot, 'repo-dedupe'),         // on-demand alias
    ])
    expect(snapshot.repositories).toHaveLength(1)
  })

  test('keeps last-valid repository entry with stale flag when discovery fails', () => {
    const repo = path.join(tempRoot, 'repo-stale')
    gitInit(repo)
    const good = buildWorkspaceSnapshot([repo])
    expect(good.repositories[0].stale).toBe(false)

    // A previously discovered repository whose seed path no longer resolves
    // (deleted/unreachable directory) is carried forward as stale.
    const ghostPath = path.join(tempRoot, 'ghost')
    const brokenId = path.join(ghostPath, '.git')
    const previous: WorkspaceSnapshot = {
      repositories: [
        {
          id: brokenId,
          name: 'ghost',
          commonDir: brokenId,
          worktrees: [
            {
              id: `${brokenId}::${ghostPath}`,
              repositoryId: brokenId,
              path: ghostPath,
              headRevision: 'abc1234',
              detached: false,
              isMain: true,
              dirty: false,
              openspec: { changes: [], stale: false },
            },
          ],
          branches: [],
          stale: false,
        },
      ],
      generatedAt: good.generatedAt,
    }
    const withGhost = buildWorkspaceSnapshot([repo, ghostPath], previous)
    const ghost = withGhost.repositories.find((candidate) => candidate.id === brokenId)
    expect(ghost?.stale).toBe(true)
    expect(ghost?.error).toBe('Git discovery failed')
    // The healthy repository is unaffected (failure isolation).
    const healthy = withGhost.repositories.find((candidate) => candidate.id === good.repositories[0].id)
    expect(healthy?.stale).toBe(false)
  })

  test('drops previous repositories whose seed paths are all gone', () => {
    const repo = path.join(tempRoot, 'repo-removal')
    gitInit(repo)
    const first = buildWorkspaceSnapshot([repo])
    expect(first.repositories).toHaveLength(1)

    // No seeds at all -> the previous repository is not carried forward.
    const emptied = buildWorkspaceSnapshot([], first)
    expect(emptied.repositories).toHaveLength(0)
  })

  test('skips repositories that never discovered successfully', () => {
    const plain = path.join(tempRoot, 'not-git')
    fs.mkdirSync(plain, { recursive: true })
    const snapshot = buildWorkspaceSnapshot([plain])
    expect(snapshot.repositories).toHaveLength(0)
  })

  test('snapshot parses cleanly through the shared validator', async () => {
    const repo = path.join(tempRoot, 'repo-validate')
    gitInit(repo)
    const snapshot = buildWorkspaceSnapshot([repo])
    const { parseWorkspaceSnapshot } = await import('../../shared/workspaceValidation')
    expect(parseWorkspaceSnapshot(snapshot)).toEqual(snapshot)
  })
})
