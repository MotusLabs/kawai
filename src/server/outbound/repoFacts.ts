// The classifier's one I/O step (execution-safety-recovery D4): repository
// facts for an effective cwd — the repository root, the team id (the common
// git dir), origin's URL, every remote's URL, and the current branch's push
// remote — read as text from the git config, with no `git` process. The
// nearest-`.git` walk matches `resolveTeam`: a `.git` directory is the
// repository itself; a `.git` file names a linked worktree whose config
// stays in the main repository's. Reads are cached per resolved config file
// by its mtime and size, and run only for send candidates (about 200 a
// month), so nothing here sits on a hot path.
import fs from 'node:fs'
import path from 'node:path'
import type { RepoFacts } from './classify'

export interface ResolvedRepoFacts extends RepoFacts {
  /** The team id (common git dir) the call's cwd belongs to. */
  teamId: string
  /** The config read failed: every git/gh target reads unknown-destination. */
  unreadable?: boolean
}

/** What the resolver needs from the filesystem; tests substitute all of it. */
export interface RepoFactsIo {
  stat(file: string): { mtimeMs: number; size: number; isDirectory: boolean } | null
  readFile(file: string): string
}

const IO: RepoFactsIo = {
  stat(file) {
    try {
      const stat = fs.statSync(file)
      return { mtimeMs: stat.mtimeMs, size: stat.size, isDirectory: stat.isDirectory() }
    } catch {
      return null
    }
  },
  readFile: file => fs.readFileSync(file, 'utf8'),
}

interface CachedFacts {
  stamp: string
  facts: ResolvedRepoFacts
}

export class RepoFactsResolver {
  private readonly cache = new Map<string, CachedFacts>()

  constructor(private readonly io: RepoFactsIo = IO) {}

  /** Facts for the repository containing `cwd`, or null when none does. */
  factsFor(cwd: string): ResolvedRepoFacts | null {
    const found = this.repositoryRootOf(cwd)
    if (found === null) return null
    const config = path.join(found.commonDir, 'config')
    const stamp = this.stampOf(config)
    const cached = this.cache.get(config)
    if (cached !== undefined && cached.stamp === stamp) return cached.facts
    const facts: ResolvedRepoFacts = {
      root: found.root,
      teamId: found.commonDir,
      ...this.readFacts(config, found.headDir),
    }
    this.cache.set(config, { stamp, facts })
    return facts
  }

  /** The walk: nearest `.git` (directory, or a worktree's `gitdir:` file), its common dir and HEAD dir. */
  private repositoryRootOf(cwd: string): { root: string; commonDir: string; headDir: string } | null {
    let dir = path.resolve(cwd)
    for (;;) {
      const dotGit = path.join(dir, '.git')
      const stat = this.io.stat(dotGit)
      if (stat !== null && stat.isDirectory) return { root: dir, commonDir: dotGit, headDir: dotGit }
      if (stat !== null) {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(this.io.readFile(dotGit))?.[1]?.trim()
        if (gitdir === undefined) return null
        // A linked worktree's dir sits under <main>/.git/worktrees/<name>;
        // remotes and branches live in the main config, its HEAD in its own.
        const common = gitdir.replace(/[/\\]worktrees[/\\][^/\\]+$/, '')
        return { root: dir, commonDir: common, headDir: gitdir }
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  private readFacts(config: string, headDir: string): Omit<ResolvedRepoFacts, 'root' | 'teamId'> {
    let text: string
    try {
      text = this.io.readFile(config)
    } catch {
      return { originUrl: null, remotes: new Map(), pushRemote: null, unreadable: true }
    }
    const remotes = new Map<string, string>()
    const branches = new Map<string, { remote?: string; pushRemote?: string }>()
    let remoteName: string | null = null
    let branchName: string | null = null
    for (const line of text.split('\n')) {
      const section = /^\s*\[\s*(remote|branch)\s+"([^"]+)"\s*\]\s*$/.exec(line)
      if (section !== null) {
        remoteName = section[1] === 'remote' ? section[2]! : null
        branchName = section[1] === 'branch' ? section[2]! : null
        continue
      }
      const pair = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line)
      if (pair === null) continue
      const key = pair[1]!.toLowerCase()
      const value = pair[2]!.trim()
      if (remoteName !== null && key === 'url') remotes.set(remoteName, value)
      if (branchName !== null) {
        const branch = branches.get(branchName) ?? {}
        if (key === 'remote') branch.remote = value
        if (key === 'pushremote') branch.pushRemote = value
        branches.set(branchName, branch)
      }
    }
    // The current branch decides whose push remote a bare `git push` uses.
    let headBranch: string | null = null
    try {
      const head = this.io.readFile(path.join(headDir, 'HEAD'))
      headBranch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null
    } catch {
      headBranch = null
    }
    const current = headBranch === null ? undefined : branches.get(headBranch)
    return {
      originUrl: remotes.get('origin') ?? null,
      remotes,
      pushRemote: current?.pushRemote ?? current?.remote ?? null,
    }
  }

  private stampOf(file: string): string {
    const stat = this.io.stat(file)
    return stat === null ? 'missing' : `${stat.mtimeMs}:${stat.size}`
  }
}
