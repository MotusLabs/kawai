// pushCheck.ts - The pre-push hook's decisions, pure (per-result-suite task
// 3.2, design D4, invariant I2; pre-push-bun-pin D3-D4). pre-push.ts gathers
// each pushed ref's facts from git and the records (the running Bun, the pin
// in the commit's own .bun-version, and which version's record certified the
// tree), and acts on the verdict decided here:
//
//   deletion                      -> skipped, no check
//   not a commit                  -> refused as unsupported
//   recorded full pass under the
//     running Bun or the pin      -> passes, naming the record's Bun
//   pin differs from the running
//     Bun, no pass                -> refused at once, naming both Buns and
//                                    the command under the pin; no check
//   HEAD at the commit, clean     -> eligible for the one fallback check
//   otherwise                     -> refused, naming the state and command
//
// With no usable pin, or a pin equal to the running Bun, every verdict is
// the one before the pin existed. Hidden index entries (skip-worktree,
// assume-unchanged) refuse every non-deletion ref: they hide edits from the
// status and the key alike (CP1 F1). Every path a line lists (a dirty path,
// or one that changed during the check) prints with its whitespace and
// control characters escaped as `\xHH`/`\u{HHHH}` under a leading `//`, in
// a form no listed path can equal, so a filename can never spell a network
// error Kawai's effect classifier would retry on ("build timed out.log"
// once read as transient, F1) and two paths never print the same; every
// other path prints unchanged.
// When any ref is refused, nothing is checked: the eligible refs are listed
// as not checked (Q1). Otherwise at most one fallback runs — every eligible
// ref is HEAD's commit, so they share HEAD's tree.

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
      /** The running Bun's version. */
      bun: string
      /** The usable pin from the commit's own .bun-version, or null. */
      pin: string | null
      /** The Bun version whose full-pass record certified the tree, or null. */
      recordedBun: string | null
      head: string | null
      /** Porcelain paths of the working tree; empty when clean. */
      dirtyPaths: string[]
    }

export type PushVerdict =
  | { kind: 'pass'; lines: string[] }
  | { kind: 'refuse'; lines: string[] }
  | { kind: 'fallback'; tree: string; commit: string; refs: string[]; lines: string[] }

export const CHECK_COMMAND = '`bun run check`'
const PIN = /^[0-9]+\.[0-9]+\.[0-9]+$/

/** The usable pin in a .bun-version's content: trimmed, MAJOR.MINOR.PATCH.
 * Absent (null), empty, or anything else is no pin. */
export function parseBunPin(content: string | null): string | null {
  if (content === null) return null
  const trimmed = content.trim()
  return PIN.test(trimmed) ? trimmed : null
}
const MAX_LISTED = 10

/** A character that forces the escaped form: a Unicode control character
 * (C0, DEL, or C1 U+007F-009F — the C1 range is controls too, F1) or JS
 * whitespace (which includes NBSP, U+2028/2029, U+FEFF, but not U+0085). */
function isSpecial(ch: string, code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/u.test(ch)
}

/** One path as a hook line prints it. A path holding JS whitespace or a
 * Unicode control character (C0, DEL, C1) prints in an escaped, marked
 * form: each such character as an explicit `\xHH` (or `\u{HHHH}` above the
 * Latin-1 range), literal backslashes doubled, the whole form under a
 * leading `//`. No listed path can begin with `/` — porcelain paths are
 * repository-relative, and git refuses to add a path with a leading slash
 * or an empty or dot component — so no ordinary path can equal an escaped
 * form, and the token code is injective, so two listed paths never print
 * the same (R3, F1). A path with neither prints unchanged (A5). The joined
 * stderr of a refusal cannot carry network wording, and the reader sees
 * exactly which characters the name holds. */
export function renderPath(path: string): string {
  let escaped = false
  for (const ch of path) {
    if (isSpecial(ch, ch.codePointAt(0)!)) {
      escaped = true
      break
    }
  }
  if (!escaped) return path
  let out = '//'
  for (const ch of path) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (isSpecial(ch, code)) out += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`
    else out += ch
  }
  return out
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map(renderPath).join(', ')
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
    if (fact.recordedBun !== null) {
      lines.push(`pre-push: ${fact.ref} ${fact.commit}: recorded full pass for tree ${fact.tree} under Bun ${fact.recordedBun}`)
      continue
    }
    // A pin the running Bun cannot satisfy: no check here can certify the
    // tree under its own pin, so name the pinned Bun (D3).
    const mismatch = fact.pin !== null && fact.pin !== fact.bun ? fact.pin : null
    const command = mismatch === null ? CHECK_COMMAND : `${CHECK_COMMAND} under Bun ${mismatch}`
    const missing =
      `pre-push: ${fact.ref} ${fact.commit}: no full-check pass for tree ${fact.tree}` +
      (mismatch === null ? '' : ` under Bun ${fact.bun} or the pinned Bun ${mismatch}`)
    if (fact.head !== fact.commit) {
      refused.push(
        `${missing}; not checked out (HEAD is ${fact.head ?? 'unborn'}): check out ${fact.commit}, ` +
          `run ${command} on the clean tree, then push`
      )
    } else if (fact.dirtyPaths.length > 0) {
      refused.push(
        `${missing}; checked out but the working tree is dirty: ${listPaths(fact.dirtyPaths)}; ` +
          `commit or stash them, run ${command}, then push`
      )
    } else if (mismatch !== null) {
      refused.push(
        `${missing}; this hook runs Bun ${fact.bun}, so it runs no check: ` +
          `run ${command} on a clean checkout of ${fact.commit}, then push`
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
