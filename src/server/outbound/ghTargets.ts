// The gh commands' repository targets (execution-safety-recovery D4, CC
// round 4 E): where a `gh <command> <verb>` sends. Split out of `rules.ts`
// when that file outgrew the 500-LOC rule; the rules table stays there.
// `-R`/`--repo`, a URL positional, a repo-subcommand positional, a fork's
// destination account, or origin — never a guessed position. Pure.
import type { SendTarget } from './classify'
import { URLISH, VARIABLE, type Scan, type Word } from './rules'

/**
 * The gh repository target: `-R`/`--repo`, a URL positional
 * (`https://github.com/o/r/pull/1`, `github.com/o/r`), a repo-subcommand's
 * positional (`gh repo delete o/r`), else the cwd's origin.
 */
export function ghRepoTarget(scanned: Scan, positionals: Word[], repoPositional = false): SendTarget {
  const value = scanned.values('-R', '--repo')[0]
  if (value !== undefined) {
    if (value.opaque) return VARIABLE()
    const asUrl = URLISH.test(value.text) ? parseRepoUrl(value.text) : null
    if (asUrl !== null) return asUrl
    const parts = value.text.split('/')
    if (parts.length === 3) return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, host: parts[0]!.toLowerCase() }
    return { kind: 'repo', repo: value.text }
  }
  // A positional URL names its repository, whatever it points at.
  const url = positionals.find(word => !word.opaque && URLISH.test(word.text))
  if (url !== undefined) return parseRepoUrl(url.text) ?? VARIABLE()
  const github = positionals.find(word => !word.opaque && word.text.startsWith('github.com/'))
  if (github !== undefined) {
    const parts = github.text.replace(/\.git$/, '').split('/')
    if (parts.length === 3) return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, host: 'github.com' }
  }
  // `gh repo <verb> <repo>`: the positional is the target; a bare name
  // reads as the caller's own account, judged against origin. An opaque
  // positional is an unknown repository, never implicit origin.
  if (repoPositional) {
    const first = positionals[0]
    if (first === undefined) return { kind: 'origin-implicit' }
    if (first.opaque) return VARIABLE()
    if (first.text.includes('/')) return { kind: 'repo', repo: first.text.replace(/\.git$/, '') }
    return { kind: 'repo', repo: `the caller's account/${first.text}` }
  }
  return { kind: 'origin-implicit' }
}

/**
 * `gh repo create` never falls back to origin (D1): the new repository is a
 * positional `owner/name` — a bare name reads as the caller's own account,
 * which can never be shown equal to origin, so it is a violation.
 */
export function ghRepoCreationTarget(scanned: Scan): SendTarget {
  const flagged = scanned.values('-R', '--repo')[0]
  const positional = flagged ?? scanned.positionals[0]
  if (positional === undefined || positional.opaque) {
    return { kind: 'repo', repo: "the caller's account/…" }
  }
  if (URLISH.test(positional.text)) return parseRepoUrl(positional.text) ?? VARIABLE()
  const name = positional.text.replace(/\.git$/, '')
  // A name with no owner means the caller's own account.
  return { kind: 'repo', repo: name.includes('/') ? name : `the caller's account/${name}` }
}

/**
 * `gh repo fork` never targets origin (D1): the destination is the `--org`
 * (else the caller's own account) over the `--fork-name` (else the source
 * repository's name). The source stays in the segment; it is never the
 * target. Opaque values leave the destination unresolved.
 */
export function ghRepoForkTarget(scanned: Scan): SendTarget {
  const org = scanned.values('--org')[0]
  const forkName = scanned.values('--fork-name')[0]
  if (org?.opaque === true || forkName?.opaque === true) return VARIABLE()
  const positional = scanned.positionals[0]
  const sourceName = positional !== undefined && !positional.opaque
    ? positional.text.replace(/\.git$/, '').split('/').pop() ?? null
    : null
  const owner = org?.text ?? "the caller's account"
  const name = forkName?.text ?? sourceName ?? 'the source name'
  return { kind: 'repo', repo: `${owner}/${name}`, fork: true }
}

function parseRepoUrl(text: string): SendTarget | null {
  try {
    const url = new URL(text)
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2) return { kind: 'host', host: url.hostname }
    return { kind: 'repo', repo: `${parts[0]}/${parts[1].replace(/\.git$/, '')}`, host: url.hostname.toLowerCase() }
  } catch {
    return null
  }
}
