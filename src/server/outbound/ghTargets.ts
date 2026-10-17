// The gh commands' repository targets (execution-safety-recovery D4): where
// a `gh <command> <verb>` or a `gh api` write sends. `-R`/`--repo`, a URL
// positional, a repo verb's positional, an issue transfer's destination, a
// secret's account, a fork's destination account, or gh's default
// repository — never a guessed position. A name with no owner reads as the
// caller's own account (`@me/<name>`), which can never be shown equal to
// origin. Pure.
import type { SendTarget } from './classify'
import { valuesOf, type Scanned } from './options'
import { unresolved } from './proof'
import { URLISH } from './targets'
import type { Word } from './tokenize'

/** How a verb names its repository. */
export type GhTargetKind = 'default' | 'repo-positional' | 'create' | 'fork' | 'gist' | 'transfer' | 'account'

/** `owner/repo`, `host/owner/repo`, or a URL; a bare name is the caller's own account. */
function namedRepo(text: string): SendTarget {
  if (URLISH.test(text)) return parseRepoUrl(text)
  const name = text.replace(/\.git$/, '')
  const parts = name.split('/')
  if (parts.length === 3) return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, host: parts[0]!.toLowerCase() }
  if (parts.length === 2) return { kind: 'repo', repo: name }
  if (parts.length === 1 && name !== '') return { kind: 'repo', repo: `@me/${name}` }
  return unresolved('target-not-url')
}

/** The target of a gh write verb (`create` and `fork` have their own). */
export function ghRepoTarget(scanned: Scanned, kind: GhTargetKind): SendTarget {
  if (kind === 'gist') return { kind: 'host', host: 'gist.github.com' }
  if (kind === 'account') {
    const org = valuesOf(scanned, '-o', '--org')[0]
    if (org !== undefined) return { kind: 'repo', repo: `${org.text}/*` }
    if (scanned.options.some(option => option.name === '-u' || option.name === '--user')) return { kind: 'repo', repo: '@me/*' }
  }
  const flagged = valuesOf(scanned, '-R', '--repo')[0]
  if (flagged !== undefined) return namedRepo(flagged.text)
  const positionals = scanned.positionals
  if (kind === 'transfer') {
    const destination = positionals[1]
    return destination === undefined ? unresolved('target-not-url') : namedRepo(destination.text)
  }
  // A positional URL names its repository, whatever it points at.
  const url = positionals.find(word => URLISH.test(word.text) || word.text.startsWith('github.com/'))
  if (url !== undefined) return parseRepoUrl(url.text.startsWith('github.com/') ? `https://${url.text}` : url.text)
  if (kind === 'repo-positional' && positionals[0] !== undefined) return namedRepo(positionals[0].text)
  return { kind: 'gh-default' }
}

/** `gh repo create` publishes somewhere new (D1): never the default repository. */
export function ghRepoCreationTarget(scanned: Scanned): SendTarget {
  const named = valuesOf(scanned, '-R', '--repo')[0] ?? scanned.positionals[0]
  if (named === undefined) return { kind: 'repo', repo: '@me/unnamed' }
  return namedRepo(named.text)
}

/**
 * `gh repo fork` never targets origin (D1): the destination is the `--org`
 * (else the caller's own account) over the `--fork-name` (else the source
 * repository's name). The source stays in the segment, never the target.
 */
export function ghRepoForkTarget(scanned: Scanned): SendTarget {
  const org = valuesOf(scanned, '--org')[0]
  const forkName = valuesOf(scanned, '--fork-name')[0]
  const source = scanned.positionals[0]
  const sourceName = source === undefined ? null : source.text.replace(/\.git$/, '').split('/').pop() ?? null
  return { kind: 'repo', repo: `${org?.text ?? '@me'}/${forkName?.text ?? sourceName ?? 'unnamed'}`, fork: true }
}

/** `gh api` writes: `repos/<owner>/<repo>/…` (placeholders mean the default repository). */
export function ghApiTarget(path: Word | undefined, hostname: Word | undefined): SendTarget {
  if (path === undefined) return unresolved('api-path-not-repo')
  const parts = path.text.replace(/^\/+/, '').split(/[/?#]/)
  if (parts[0] !== 'repos' || parts.length < 3 || parts[1] === '' || parts[2] === '') return unresolved('api-path-not-repo')
  const host = hostname === undefined ? undefined : hostname.text.toLowerCase()
  if (parts[1] === '{owner}' && parts[2] === '{repo}') return host === undefined ? { kind: 'gh-default' } : unresolved('api-path-not-repo')
  if (parts[1]!.includes('{') || parts[2]!.includes('{')) return unresolved('api-path-not-repo')
  return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, ...(host === undefined ? {} : { host }) }
}

function parseRepoUrl(text: string): SendTarget {
  try {
    const url = new URL(text)
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2 || parts[0] === '' || parts[1] === '') return { kind: 'host', host: url.hostname.toLowerCase() }
    return { kind: 'repo', repo: `${parts[0]}/${parts[1]!.replace(/\.git$/, '')}`, host: url.hostname.toLowerCase() }
  } catch {
    return unresolved('target-not-url')
  }
}
