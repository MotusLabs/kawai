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
  /** origin's `url` lines, for repository equality. */
  originUrls: readonly string[]
  /**
   * Every remote as a push resolves it: its `pushurl` lines when it has any,
   * else its `url` lines — git pushes to every line, so all are kept.
   */
  remotes: ReadonlyMap<string, readonly string[]>
  /** Per branch: `remote` and `pushRemote` settings. */
  branches: ReadonlyMap<string, { remote?: string; pushRemote?: string }>
  /** `remote.pushDefault`, the fallback push remote for every branch. */
  pushDefault: string | null
  /**
   * Why no target may resolve from this config: an include, an insteadOf
   * rewrite, or a header form the parser does not read exactly.
   */
  pinned: string | null
}

interface CachedConfig {
  stamp: string
  config: ParsedConfig
}

/** The unreadable stand-in: every git/gh target reads unknown-destination. */
const UNREADABLE: ParsedConfig = { originUrls: [], remotes: new Map(), branches: new Map(), pushDefault: null, pinned: 'the config read failed' }

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
    // The branch's push remote chain (git's precedence): branch pushRemote,
    // remote.pushDefault, branch remote, origin.
    const chain = current?.pushRemote ?? parsed.pushDefault ?? current?.remote ?? 'origin'
    return {
      root: found.root,
      teamId: found.commonDir,
      originUrls: parsed.originUrls,
      remotes: parsed.remotes,
      pushRemote: chain,
      ...(parsed.pinned !== null ? { pinned: parsed.pinned } : {}),
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
   * Git config text (D4, CC round 4): any `[` line is a section header —
   * quoted `[remote "x"]`, dotted `[remote.x]`, either with a trailing
   * comment, names case-insensitively — and a header the parser cannot read
   * exactly pins the facts unresolved rather than silently skipping. Values
   * lose their comment and quoting; CRLF lines read like LF; duplicate
   * sections merge. An `[include]`/`[includeIf]` or an `insteadOf` rewrite
   * pins too, because the parser cannot follow what they change.
   */
  private parseConfig(text: string | null): ParsedConfig {
    if (text === null) return UNREADABLE
    const urls = new Map<string, string[]>()
    const pushurls = new Map<string, string[]>()
    const branches = new Map<string, { remote?: string; pushRemote?: string }>()
    let pushDefault: string | null = null
    let pinned: string | null = null
    const pin = (why: string): void => { if (pinned === null) pinned = why }
    type Section = { kind: 'remote'; name: string } | { kind: 'remote-global' } | { kind: 'branch'; name: string } | { kind: 'ignored' }
    let section: Section | null = null
    const stripComment = (line: string): string => {
      let quote: '' | "'" | '"' = ''
      for (let i = 0; i < line.length; i++) {
        const char = line[i]!
        if (quote !== '') { if (char === quote && line[i - 1] !== '\\') quote = '' }
        else if (char === "'" || char === '"') quote = char
        else if (char === '#' || char === ';') return line.slice(0, i).trimEnd()
      }
      return line
    }
    const headerOf = (line: string): [string, string | null, boolean] | null => {
      const body = stripComment(line)
      const quoted = /^\[\s*([A-Za-z0-9-]+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/.exec(body)
      if (quoted !== null) return [quoted[1]!.toLowerCase(), quoted[2]!, true]
      const dotted = /^\[\s*([A-Za-z0-9-]+)\.([A-Za-z0-9.-]+)\s*\]$/.exec(body)
      if (dotted !== null) return [dotted[1]!.toLowerCase(), dotted[2]!, false]
      const bare = /^\[\s*([A-Za-z0-9-]+)\s*\]$/.exec(body)
      if (bare !== null) return [bare[1]!.toLowerCase(), null, false]
      return null
    }
    const unquote = (value: string | undefined): string => {
      if (value === undefined) return ''
      const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value.trim())
      if (quoted === null) return value.trim()
      return quoted[1]!.replace(/\\(["\\])/g, '$1')
    }
    // A # or ; comment runs to the END OF THE LINE (round 6 B4): a
    // backslash inside a comment continues nothing, so comments strip before
    // any folding; a trailing backslash then continues the value.
    const folded: string[] = []
    for (const raw of text.split(/\r?\n/)) {
      const line = stripComment(raw.trim())
      if (folded.length > 0 && folded[folded.length - 1]!.endsWith('\\')) {
        folded[folded.length - 1] = folded[folded.length - 1]!.slice(0, -1) + line
      } else {
        folded.push(line)
      }
    }
    for (const line of folded) {
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      if (line.startsWith('[')) {
        const header = headerOf(line)
        if (header === null) { pin('a config header was not understood'); section = null; continue }
        const [word, name, quoted] = header
        if (word === 'include' || word.startsWith('includeif')) { pin('an include directive could change this config'); section = null; continue }
        if (word === 'url') { pin('an insteadOf rewrite could change this target'); section = { kind: 'ignored' }; continue }
        // A quoted subsection is case-sensitive as git reads it; only the
        // legacy dotted form lowercases (round 6 L1).
        const dotted = quoted === null && name !== null
        const key = dotted ? name.toLowerCase() : name
        section = word === 'remote'
          ? key === null ? { kind: 'remote-global' } : { kind: 'remote', name: key }
          : word === 'branch' && key !== null ? { kind: 'branch', name: key } : { kind: 'ignored' }
        continue
      }
      const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
      if (pair === null || section === null) continue
      const key = pair[1]!.toLowerCase()
      const value = unquote(pair[2]!)
      if (section.kind === 'remote') {
        if (key === 'url') { const list = urls.get(section.name) ?? []; list.push(value); urls.set(section.name, list) }
        if (key === 'pushurl') { const list = pushurls.get(section.name) ?? []; list.push(value); pushurls.set(section.name, list) }
        if (key === 'insteadof' || key === 'pushinsteadof') pin('an insteadOf rewrite could change this target')
      } else if (section.kind === 'remote-global') {
        if (key === 'pushdefault') pushDefault = value
      } else if (section.kind === 'ignored') {
        // extensions.worktreeConfig moves config into an unread per-worktree
        // file: nothing may resolve (round 5 R4).
        if (key === 'worktreeconfig' && (value === '' || value === undefined || /^(true|1|yes|on)$/i.test(value))) pin('worktree config is not read')
      } else if (section.kind === 'branch') {
        const branch = branches.get(section.name) ?? {}
        if (key === 'remote') branch.remote = value
        if (key === 'pushremote') branch.pushRemote = value
        branches.set(section.name, branch)
      }
    }
    const remotes = new Map<string, readonly string[]>()
    for (const name of new Set([...urls.keys(), ...pushurls.keys()])) {
      const push = pushurls.get(name)
      const plain = urls.get(name) ?? []
      // A pushurl replaces the urls; without one, git pushes to every url.
      remotes.set(name, push !== undefined && push.length > 0 ? push : plain)
    }
    return { originUrls: urls.get('origin') ?? [], remotes, branches, pushDefault, pinned }
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
