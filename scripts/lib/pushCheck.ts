// pushCheck.ts - The pre-push hook's decisions, pure (per-result-suite task
// 3.2, design D4, invariant I2). pre-push.ts gathers each pushed ref's facts
// from git and the records, and acts on the verdict decided here:
//
//   deletion                      -> skipped, no check
//   not a commit                  -> refused as unsupported
//   recorded full pass            -> passes
//   HEAD at the commit, clean     -> eligible for the one fallback check
//   otherwise                     -> refused, naming the state and command
//
// Hidden index entries (skip-worktree, assume-unchanged) refuse every
// non-deletion ref: they hide edits from the status and the key alike (CP1
// F1). When any ref is refused, nothing is checked: the eligible refs are
// listed as not checked (Q1). Otherwise at most one fallback runs — every
// eligible ref is HEAD's commit, so they share HEAD's tree.

import { describeHidden, type HiddenEntry } from '../../src/server/checks/checkKey'

export interface PushLine {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function isZeroSha(sha: string): boolean {
  return SHA.test(sha) && /^0+$/.test(sha)
}

/** Parse pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`
 * per line. Any malformed line refuses the whole input (fail closed). */
export function parsePushInput(input: string): { ok: true; lines: PushLine[] } | { ok: false; error: string } {
  const lines: PushLine[] = []
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const fields = line.split(' ')
    if (fields.length !== 4 || fields.some((field) => field === '') || !SHA.test(fields[1]) || !SHA.test(fields[3])) {
      return { ok: false, error: `unreadable pre-push input: ${JSON.stringify(line)}` }
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields
    lines.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return { ok: true, lines }
}

export type RefFacts =
  | { kind: 'deletion'; ref: string }
  | { kind: 'unsupported'; ref: string; sha: string }
  | {
      kind: 'commit'
      ref: string
      commit: string
      tree: string
      recorded: boolean
      head: string | null
      /** Porcelain paths of the working tree; empty when clean. */
      dirtyPaths: string[]
    }

export type PushVerdict =
  | { kind: 'pass'; lines: string[] }
  | { kind: 'refuse'; lines: string[] }
  | { kind: 'fallback'; tree: string; commit: string; refs: string[]; lines: string[] }

export const CHECK_COMMAND = '`bun run check`'
const MAX_LISTED = 10

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(', ')
  return paths.length > MAX_LISTED ? `${shown}, … (${paths.length} in all)` : shown
}

export function decidePush(facts: RefFacts[], hiddenEntries: HiddenEntry[]): PushVerdict {
  const lines: string[] = []
  const refused: string[] = []
  const eligible: Extract<RefFacts, { kind: 'commit' }>[] = []

  for (const fact of facts) {
    if (fact.kind === 'deletion') {
      lines.push(`pre-push: ${fact.ref}: deletion, no check`)
      continue
    }
    if (hiddenEntries.length > 0) {
      refused.push(
        `pre-push: ${fact.ref}: refused: the index hides edits from the check. ${describeHidden(hiddenEntries)} ` +
          `Then ${CHECK_COMMAND} and push.`
      )
      continue
    }
    if (fact.kind === 'unsupported') {
      refused.push(`pre-push: unsupported ref ${fact.ref}: ${fact.sha} is not a commit`)
      continue
    }
    if (fact.recorded) {
      lines.push(`pre-push: ${fact.ref} ${fact.commit}: recorded full pass for tree ${fact.tree}`)
      continue
    }
    const missing = `pre-push: ${fact.ref} ${fact.commit}: no full-check pass for tree ${fact.tree}`
    if (fact.head !== fact.commit) {
      refused.push(
        `${missing}; not checked out (HEAD is ${fact.head ?? 'unborn'}): check out ${fact.commit}, ` +
          `run ${CHECK_COMMAND} on the clean tree, then push`
      )
    } else if (fact.dirtyPaths.length > 0) {
      refused.push(
        `${missing}; checked out but the working tree is dirty: ${listPaths(fact.dirtyPaths)}; ` +
          `commit or stash them, run ${CHECK_COMMAND}, then push`
      )
    } else {
      eligible.push(fact)
    }
  }

  if (refused.length > 0) {
    for (const fact of eligible) {
      lines.push(
        `pre-push: ${fact.ref} ${fact.commit}: not checked: push refused anyway; push ${fact.ref} separately to run its check`
      )
    }
    return { kind: 'refuse', lines: [...refused, ...lines] }
  }
  if (eligible.length === 0) return { kind: 'pass', lines }
  const [first] = eligible
  return {
    kind: 'fallback',
    tree: first.tree,
    commit: first.commit,
    refs: eligible.map((fact) => fact.ref),
    lines: [...lines, `pre-push: ${eligible.map((f) => f.ref).join(', ')} ${first.commit}: no recorded pass; running ${CHECK_COMMAND} on the clean tree`],
  }
}

/** After the fallback check: pass only on its exact key's record (I2). */
export function settleFallback(
  verdict: Extract<PushVerdict, { kind: 'fallback' }>,
  exitCode: number,
  recorded: boolean,
  dirtyPaths: string[]
): { code: number; line: string } {
  if (exitCode !== 0) {
    return { code: 1, line: `pre-push: ${verdict.commit}: the full check failed (exit ${exitCode}); push refused` }
  }
  if (!recorded) {
    const changed = dirtyPaths.length > 0 ? ` (the tree changed during the check: ${listPaths(dirtyPaths)})` : ''
    return {
      code: 1,
      line: `pre-push: ${verdict.commit}: the full check passed but recorded no pass for tree ${verdict.tree}${changed}; push refused`,
    }
  }
  return { code: 0, line: `pre-push: ${verdict.commit}: full check passed for tree ${verdict.tree}` }
}
