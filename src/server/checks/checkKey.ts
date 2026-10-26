// checkKey.ts - Content key for `bun run check` (check-dedup D1).
//
// The key identifies the working tree's content: a tree id computed on a
// TEMPORARY COPY of the git index (`git add -A` + `git write-tree` with
// GIT_INDEX_FILE pointing at the copy), hashed together with the Bun version
// and platform. The real index is never opened for writing — its stat cache
// survives, so an unchanged tree re-adds in milliseconds, and a test asserts
// it stays byte-identical. `add -A` restages every path, so the key is
// always the WORKING TREE's (untracked non-ignored files included), whatever
// index was copied: the copy only seeds the stat cache.
//
// An index entry flagged skip-worktree or assume-unchanged hides its on-disk
// content from `add -A`, so the tree id would name content the steps never
// read (per-result-suite CP1 F1). computeContentKey refuses such an index:
// no record is written or accepted for a tree it could not see.
//
// Every git call here runs through runGit's cleanGitEnv, so the GIT_DIR /
// GIT_INDEX_FILE variables a pre-commit hook exports cannot redirect these
// commands; the temporary index rides the explicit env option instead.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'

// `git add -A` over a whole tree can take longer than the default 10 s on a
// cold cache; the copy itself is a file copy.
const KEY_GIT_TIMEOUT_MS = 60_000

export interface ContentKey {
  key: string
  treeId: string
  bunVersion: string
  platform: string
  arch: string
}

/**
 * Hash the key inputs (design D1). Separated with NUL bytes so a tree id
 * cannot run into a version string. Pure, so tests can cover every input
 * without spawning git.
 */
export function contentKeyFrom(parts: Omit<ContentKey, 'key'>): string {
  return createHash('sha256')
    .update([parts.treeId, parts.bunVersion, parts.platform, parts.arch].join('\0'))
    .digest('hex')
}

function gitOrThrow(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  trim = true
): string {
  const result = runGit(args, { cwd, timeoutMs: KEY_GIT_TIMEOUT_MS, env })
  if (!result.ok) {
    throw new Error(`check: git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }
  return trim ? result.stdout.trim() : result.stdout
}

/**
 * The repository's index path. `git rev-parse --git-path` answers relative to
 * the git process's cwd, so a relative answer is joined to that cwd — never
 * to this process's own working directory, which may be anywhere.
 */
export function resolveIndexPath(cwd: string): string {
  const answer = gitOrThrow(['rev-parse', '--git-path', 'index'], cwd)
  return path.isAbsolute(answer) ? answer : path.join(cwd, answer)
}

/** An index entry whose working-tree content git does not look at. */
export interface HiddenEntry {
  path: string
  skipWorktree: boolean
  assumeUnchanged: boolean
}

const MAX_NAMED = 20

function shellWord(word: string): string {
  return /^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The per-path fix for `entries`: one `git update-index` command per flag,
 * naming that flag's paths (the first 20), plus the sparse-checkout note —
 * a sparse checkout marks every excluded path skip-worktree. */
export function describeHidden(entries: HiddenEntry[]): string {
  const parts: string[] = []
  for (const [flag, paths] of [
    ['skip-worktree', entries.filter((entry) => entry.skipWorktree).map((entry) => entry.path)],
    ['assume-unchanged', entries.filter((entry) => entry.assumeUnchanged).map((entry) => entry.path)],
  ] as const) {
    if (paths.length === 0) continue
    const more = paths.length > MAX_NAMED ? ` (+${paths.length - MAX_NAMED} more)` : ''
    const named = paths.slice(0, MAX_NAMED)
    parts.push(
      `${flag}: ${named.join(', ')}${more} — clear with ` +
        `\`git update-index --no-${flag} -- ${named.map(shellWord).join(' ')}\``
    )
  }
  return (
    `${parts.join('; ')}. Sparse checkouts are not supported: run \`git sparse-checkout disable\` ` +
    'in a sparse checkout.'
  )
}

/** Thrown when the index hides working-tree content from the key. */
export class HiddenIndexEntriesError extends Error {
  constructor(readonly entries: HiddenEntry[]) {
    super(
      `check: ${entries.length} index entr${entries.length === 1 ? 'y hides' : 'ies hide'} working-tree ` +
        `content from the key. ${describeHidden(entries)} Then rerun.`
    )
    this.name = 'HiddenIndexEntriesError'
  }
}

/**
 * The entries flagged skip-worktree (`S`, or `s` with assume-unchanged too)
 * or assume-unchanged (a lowercase tag) in `git ls-files -v` output, NUL
 * delimited. Pure, so the tag rule is tested without git.
 */
export function hiddenEntries(lsFilesV: string): HiddenEntry[] {
  const hidden: HiddenEntry[] = []
  for (const entry of lsFilesV.split('\0')) {
    if (entry.length < 3 || entry[1] !== ' ') continue
    const tag = entry[0]
    const assumeUnchanged = tag >= 'a' && tag <= 'z'
    const skipWorktree = tag === 'S' || tag === 's'
    if (skipWorktree || assumeUnchanged) hidden.push({ path: entry.slice(2), skipWorktree, assumeUnchanged })
  }
  return hidden
}

/** The hidden entries of the index behind `cwd` (or `indexFile`). */
export function listHiddenEntries(cwd: string, indexFile?: string): HiddenEntry[] {
  const env = indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : undefined
  return hiddenEntries(gitOrThrow(['ls-files', '-v', '-z'], cwd, env, false))
}

/**
 * Compute the working tree's content key. Throws outside a repository, on a
 * git failure (a conflicted index, for example), when the index path cannot
 * be resolved, or when an index entry hides its on-disk content
 * (HiddenIndexEntriesError) — a check must never cache under a key it could
 * not derive from what its steps read.
 *
 * @param indexFile the index to copy. Defaults to the repository's index;
 *   a pre-commit hook passes its own GIT_INDEX_FILE here explicitly (read
 *   from the environment before the check strips GIT_* from step
 *   environments). It only seeds the copy's stat cache: the key is the
 *   working tree's either way.
 */
export function computeContentKey(options: { cwd: string; indexFile?: string }): ContentKey {
  const { cwd, indexFile } = options
  const sourceIndex = indexFile ?? resolveIndexPath(cwd)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-check-key-'))
  const tempIndex = path.join(tempDir, 'index')
  try {
    if (fs.existsSync(sourceIndex)) {
      // Copying (not re-adding) keeps git's stat cache, so an unchanged tree
      // makes `git add -A` a near no-op.
      fs.copyFileSync(sourceIndex, tempIndex)
    }
    const indexEnv = { GIT_INDEX_FILE: tempIndex }
    const hidden = hiddenEntries(gitOrThrow(['ls-files', '-v', '-z'], cwd, indexEnv, false))
    if (hidden.length > 0) throw new HiddenIndexEntriesError(hidden)
    gitOrThrow(['add', '-A'], cwd, indexEnv)
    const treeId = gitOrThrow(['write-tree'], cwd, indexEnv)
    return {
      key: contentKeyFrom({
        treeId,
        bunVersion: Bun.version,
        platform: process.platform,
        arch: process.arch,
      }),
      treeId,
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
