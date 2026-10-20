// checkKey.ts - Content key for `bun run check` (check-dedup D1).
//
// The key identifies the working tree's content: a tree id computed on a
// TEMPORARY COPY of the git index (`git add -A` + `git write-tree` with
// GIT_INDEX_FILE pointing at the copy), hashed together with the Bun version
// and platform. The real index is never opened for writing — its stat cache
// survives, so an unchanged tree re-adds in milliseconds, and a test asserts
// it stays byte-identical.
//
// Every git call here runs through runGit's cleanGitEnv, so the GIT_DIR /
// GIT_INDEX_FILE variables a pre-commit hook exports cannot redirect these
// commands; the temporary index rides the explicit env option instead.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../../src/server/git/gitCommand'

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

function gitOrThrow(args: string[], cwd: string, env?: Record<string, string>): string {
  const result = runGit(args, { cwd, timeoutMs: KEY_GIT_TIMEOUT_MS, env })
  if (!result.ok) {
    throw new Error(`check: git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }
  return result.stdout.trim()
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

/**
 * Compute the working tree's content key. Throws outside a repository, on a
 * git failure (a conflicted index, for example), or when the index path
 * cannot be resolved — a check must never cache under a key it could not
 * derive.
 *
 * @param indexFile the index to copy. Defaults to the repository's index;
 *   a pre-commit hook passes its own GIT_INDEX_FILE here explicitly (read
 *   from the environment before the check strips GIT_* from step
 *   environments), so the key still reflects the commit's staged content.
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
