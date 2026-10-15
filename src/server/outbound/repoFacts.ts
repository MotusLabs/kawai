// The classifier's one I/O step (execution-safety-recovery D4): repository
// facts for an effective cwd — the repository root, the team id (the common
// git dir), origin's URL, every remote's URL, and the current branch's push
// remote — read as text from the git config, with no `git` process. The
// nearest-`.git` walk matches `resolveTeam`: a `.git` directory is the
// repository itself; a `.git` file names a linked worktree whose config
// stays in the main repository's. Only the parsed config text is cached, by
// its file's mtime and size: the walk, the root, and the worktree's own
// HEAD are computed per call, so linked worktrees sharing one config never
// inherit each other's root or branch. Reads run only for send candidates
// (about 200 a month), so nothing here sits on a hot path.
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

/** One parsed config, shared by every worktree whose common dir holds it. */
interface ParsedConfig {
  originUrl: string | null
  /** Every remote, as a push resolves it: `pushurl` when set, else `url`. */
  remotes: ReadonlyMap<string, string>
  /** Per branch: `remote` and `pushRemote` settings. */
  branches: ReadonlyMap<string, { remote?: string; pushRemote?: string }>
}

interface CachedConfig {
  stamp: string
  config: ParsedConfig
}

/** The unreadable stand-in: every git/gh target reads unknown-destination. */
const UNREADABLE: ParsedConfig = { originUrl: null, remotes: new Map(), branches: new Map() }

export class RepoFactsResolver {
  /** Parsed config by config path, kept while the file's stamp holds. */
  private readonly cache = new Map<string, CachedConfig>()

  constructor(private readonly io: RepoFactsIo = IO) {}

  /** Facts for the repository containing `cwd`, or null when none does. */
  factsFor(cwd: string): ResolvedRepoFacts | null {
    const found = this.repositoryRootOf(cwd)
    if (found === null) return null
    const config = path.join(found.commonDir, 'config')
    const parsed = this.parsedConfig(config)
    // The worktree's own HEAD decides whose push remote a bare `git push`
    // uses; it is read per call, never cached with the shared config.
    const headBranch = this.headBranchOf(found.headDir)
    const current = headBranch === null ? undefined : parsed.branches.get(headBranch)
    return {
      root: found.root,
      teamId: found.commonDir,
      originUrl: parsed.originUrl,
      remotes: parsed.remotes,
      pushRemote: current?.pushRemote ?? current?.remote ?? null,
      ...(parsed === UNREADABLE ? { unreadable: true } : {}),
    }
  }

  /** The parsed config, cached by its stamp (an unreadable read too). */
  private parsedConfig(config: string): ParsedConfig {
    const stamp = this.stampOf(config)
    const cached = this.cache.get(config)
    if (cached !== undefined && cached.stamp === stamp) return cached.config
    const parsed = this.parseConfig(this.tryRead(config))
    this.cache.set(config, { stamp, config: parsed })
    return parsed
  }

  private tryRead(file: string): string | null {
    try {
      return this.io.readFile(file)
    } catch {
      return null
    }
  }

  /**
   * Git config text: a `[section "name"]` header opens a section and closes
   * the last, whatever the section is — a `[submodule] url` after a
   * `[remote "fork"]` never touches fork's. A remote's push target prefers
   * `pushurl` over `url`.
   */
  private parseConfig(text: string | null): ParsedConfig {
    if (text === null) return UNREADABLE
    const remotes = new Map<string, string>()
    const branches = new Map<string, { remote?: string; pushRemote?: string }>()
    type Section =
      | { kind: 'remote'; name: string; url?: string; pushurl?: string }
      | { kind: 'branch'; name: string; remote?: string; pushRemote?: string }
    let section: Section | null = null
    const commitSection = () => {
      if (section === null) return
      if (section.kind === 'remote') remotes.set(section.name, section.pushurl ?? section.url ?? '')
      else {
        const branch = branches.get(section.name) ?? {}
        if (section.remote !== undefined) branch.remote = section.remote
        if (section.pushRemote !== undefined) branch.pushRemote = section.pushRemote
        branches.set(section.name, branch)
      }
      section = null
    }
    for (const line of text.split('\n')) {
      const header = /^\s*\[\s*([A-Za-z0-9-]+)(?:\s+"([^"]+)")?\s*\]\s*$/.exec(line)
      if (header !== null) {
        commitSection()
        if (header[2] === undefined) continue
        section = header[1] === 'remote'
          ? { kind: 'remote', name: header[2] }
          : header[1] === 'branch' ? { kind: 'branch', name: header[2] } : null
        continue
      }
      const pair = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line)
      if (pair === null || section === null) continue
      const key = pair[1]!.toLowerCase()
      const value = pair[2]!.trim()
      if (section.kind === 'remote') {
        if (key === 'url') section.url = value
        if (key === 'pushurl') section.pushurl = value
      } else {
        if (key === 'remote') section.remote = value
        if (key === 'pushremote') section.pushRemote = value
      }
    }
    commitSection()
    return { originUrl: remotes.get('origin') ?? null, remotes, branches }
  }

  /** The walk: nearest `.git` (directory, or a worktree's `gitdir:` file), its common dir and HEAD dir. */
  private repositoryRootOf(cwd: string): { root: string; commonDir: string; headDir: string } | null {
    let dir = path.resolve(cwd)
    for (;;) {
      const dotGit = path.join(dir, '.git')
      const stat = this.io.stat(dotGit)
      if (stat !== null && stat.isDirectory) return { root: dir, commonDir: dotGit, headDir: dotGit }
      if (stat !== null) {
        // A worktree pointer; unreadable content or no `gitdir:` line means
        // no repository facts can come from it.
        const text = this.tryRead(dotGit)
        if (text === null) return null
        const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null
        if (gitdir === null) return null
        // A linked worktree's dir sits under <main>/.git/worktrees/<name>;
        // remotes and branches live in the main config, its HEAD in its
        // own. A relative `gitdir:` resolves against the .git file's dir.
        const headDir = path.resolve(path.dirname(dotGit), gitdir)
        const common = headDir.replace(/[/\\]worktrees[/\\][^/\\]+$/, '')
        return { root: dir, commonDir: common, headDir }
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  /** The branch HEAD names, or null for detached or unreadable. */
  private headBranchOf(headDir: string): string | null {
    const head = this.tryRead(path.join(headDir, 'HEAD'))
    return head === null ? null : /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null
  }

  private stampOf(file: string): string {
    const stat = this.io.stat(file)
    return stat === null ? 'missing' : `${stat.mtimeMs}:${stat.size}`
  }
}
