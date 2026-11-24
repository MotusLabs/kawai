// pre-push.ts - The push hook (per-result-suite task 3.2, design D4, I2;
// pre-push-bun-pin D1-D3). .githooks/pre-push execs this with git's stdin.
// Each pushed commit's pin is its own tree's .bun-version
// (`<commit>:.bun-version`, never the working tree or the index). A commit
// passes when its tree has a full-pass record under this platform and
// architecture and either the running Bun or that pin — no other version.
// With no such pass and a pin that differs from the running Bun, the ref is
// refused at once, naming both Buns and the command: no check starts.
// Otherwise (no usable pin, or the pin is the running Bun) it passes only
// after this hook ran the full check itself with HEAD at that commit and a
// clean working tree — and that check recorded the exact tree's key.
// Everything else is refused, naming the commit and the command. Deletions
// run nothing. All stdin is buffered before anything runs, so the child
// check cannot consume the remaining refs. The decisions are
// lib/pushCheck.ts; this file gathers the facts and runs the one fallback.

import path from 'node:path'
import { runGit } from '../src/server/git/gitCommand'
import { listHiddenEntries } from '../src/server/checks/checkKey'
import { recordsDir } from '../src/server/checks/checkRecords'
import { stepEnv } from './lib/checkRun'
import { decidePush, isZeroSha, parseBunPin, parsePushInput, settleFallback, type PushLine, type RefFacts } from './lib/pushCheck'
import { readTreeRecord } from './lib/treeRecord'

export interface PrePushDeps {
  root: string
  env: NodeJS.ProcessEnv
  /** Run the full check; resolves to its exit code. */
  runFullCheck: (cwd: string, env: NodeJS.ProcessEnv) => Promise<number>
  log: (line: string) => void
  error: (line: string) => void
}

function git(root: string, args: string[]): string | null {
  const result = runGit(args, { cwd: root })
  return result.ok ? result.stdout.trim() : null
}

/** Porcelain paths of the working tree, untracked included; null on failure.
 * In -z format a rename or copy carries its old path as the token after the
 * entry, with no XY prefix; both names come back intact, and pushCheck
 * escapes them when a line lists them. */
export function dirtyPaths(root: string): string[] | null {
  const result = runGit(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root })
  if (!result.ok) return null
  const tokens = result.stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index]!
    // Each entry is XY, a space, and the path; the trailing token is empty.
    if (entry.length < 3 || entry[2] !== ' ') continue
    paths.push(entry.slice(3))
    const xy = entry.slice(0, 2)
    if (xy.includes('R') || xy.includes('C')) {
      const oldPath = tokens[index + 1]
      if (oldPath !== undefined && oldPath !== '') paths.push(oldPath)
      index += 1
    }
  }
  return paths
}

/** The usable pin in `commit`'s own tree, or null (D1): absent, unreadable,
 * empty, or malformed content is no pin. */
export function readCommitPin(root: string, commit: string): string | null {
  const result = runGit(['cat-file', 'blob', `${commit}:.bun-version`], { cwd: root })
  return parseBunPin(result.ok ? result.stdout : null)
}

/** The version whose record certifies `tree`: the running Bun's first, then
 * the pin's when it differs — never a third version (D2). */
export function recordedBunFor(dir: string, tree: string, pin: string | null, now: number): string | null {
  if (readTreeRecord(dir, tree, now) !== null) return Bun.version
  if (pin !== null && pin !== Bun.version && readTreeRecord(dir, tree, now, pin) !== null) return pin
  return null
}

export function gatherFacts(root: string, lines: PushLine[], now = Date.now()): RefFacts[] {
  const dir = recordsDir(root)
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  // Facts are read once per tree (the pin is the tree's own file); a failed
  // status reads as dirty (fail closed).
  const byTree = new Map<string, { pin: string | null; recordedBun: string | null }>()
  let status: string[] | undefined
  return lines.map((line): RefFacts => {
    if (isZeroSha(line.localSha)) return { kind: 'deletion', ref: line.remoteRef }
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${line.localSha}^{commit}`])
    const tree = commit === null ? null : git(root, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])
    if (commit === null || tree === null) return { kind: 'unsupported', ref: line.localRef, sha: line.localSha }
    let known = byTree.get(tree)
    if (known === undefined) {
      const pin = readCommitPin(root, commit)
      known = { pin, recordedBun: recordedBunFor(dir, tree, pin, now) }
      byTree.set(tree, known)
    }
    if (status === undefined && known.recordedBun === null && head === commit) {
      status = dirtyPaths(root) ?? ['(git status failed)']
    }
    return {
      kind: 'commit',
      ref: line.localRef,
      commit,
      tree,
      bun: Bun.version,
      pin: known.pin,
      recordedBun: known.recordedBun,
      head,
      dirtyPaths: status ?? [],
    }
  })
}

/** Run the hook over buffered stdin. Returns the exit code. */
export async function runPrePush(input: string, deps: PrePushDeps): Promise<number> {
  const parsed = parsePushInput(input)
  if (!parsed.ok) {
    deps.error(`pre-push: ${parsed.error}; push refused`)
    return 1
  }
  if (parsed.lines.length === 0) return 0
  let hidden: string[]
  try {
    hidden = listHiddenEntries(deps.root)
  } catch (error) {
    deps.error(`pre-push: cannot read the index (${error instanceof Error ? error.message : String(error)}); push refused`)
    return 1
  }
  const verdict = decidePush(gatherFacts(deps.root, parsed.lines), hidden)
  if (verdict.kind === 'refuse') {
    for (const line of verdict.lines) deps.error(line)
    return 1
  }
  for (const line of verdict.lines) deps.log(line)
  if (verdict.kind === 'pass') return 0

  const code = await deps.runFullCheck(deps.root, stepEnv(deps.env))
  const recorded = readTreeRecord(recordsDir(deps.root), verdict.tree) !== null
  const settled = settleFallback(verdict, code, recorded, recorded ? [] : (dirtyPaths(deps.root) ?? []))
  ;(settled.code === 0 ? deps.log : deps.error)(settled.line)
  return settled.code
}

function defaultRunFullCheck(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const proc = Bun.spawn({ cmd: ['bun', 'run', 'check'], cwd, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
    return proc.exited
  } catch (error) {
    console.error(`pre-push: cannot start bun run check: ${String(error)}`)
    return Promise.resolve(1)
  }
}

async function main(): Promise<number> {
  // Buffer every ref before anything else runs.
  const input = await Bun.stdin.text()
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (!top.ok) {
    console.error(`pre-push: not a git repository (${top.stderr.trim()}); push refused`)
    return 1
  }
  return await runPrePush(input, {
    root: path.resolve(top.stdout.trim()),
    env: process.env,
    runFullCheck: defaultRunFullCheck,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`pre-push: ${error instanceof Error ? error.message : String(error)}; push refused`)
      process.exit(1)
    })
}
