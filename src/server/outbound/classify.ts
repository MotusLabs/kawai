// The outbound classifier's judging half (execution-safety-recovery D4):
// pure verdicts over parsed send candidates. `judge` resolves one candidate's
// target against the destination classes (D2) and the repository facts the
// resolver read — origin's URL, every remote, the branch's push remote — and
// returns a verdict with a destination string. A candidate that failed one
// of the four checks (`proof.ts`) is never allowed: it reads
// unknown-destination with that check's fixed code, unless its target
// resolves anyway and resolves elsewhere — then it is a violation. `allowed`
// is only ever proved (task revision 3). `strongest` reduces a call's
// candidates to its row: violation beats unknown-destination beats allowed,
// rule order breaking ties. Rule ids are append-only (contract E3) and
// `CLASSIFIER_VERSION` pins the rule set that judged a row, so a later rule
// change never rewrites history.
import type { FailureCode, UnresolvedCode } from './proof'

export const CLASSIFIER_VERSION = 3

export type OutboundRule =
  | 'git-push' | 'gh-write' | 'gh-api-write'
  | 'registry-publish' | 'http-send' | 'mail-send' | 'mcp-call' | 'shell-call' | 'unclassified-send'

/** E3: append-only; the order breaks verdict ties. Version 3 never emits `shell-call`. */
export const RULE_ORDER: readonly OutboundRule[] = [
  'git-push', 'gh-write', 'gh-api-write', 'registry-publish', 'http-send', 'mail-send', 'mcp-call', 'shell-call', 'unclassified-send',
]

/** What a candidate sends to, before judging (D4). */
export type SendTarget =
  | { kind: 'origin-implicit' }
  /** gh's default repository: `gh-resolved`, else upstream, github, origin. */
  | { kind: 'gh-default' }
  | { kind: 'remote'; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'host'; host: string; port?: number }
  | { kind: 'registry'; host: string; port?: number }
  | { kind: 'repo'; repo: string; host?: string; /** A fork destination: never origin, always out. */ fork?: true }
  | { kind: 'mail' }
  | { kind: 'mcp'; server: string }
  | { kind: 'unresolved'; code: UnresolvedCode }

export interface SendCandidate {
  rule: OutboundRule
  /** The segment as reconstructed words; redacted before it is stored. */
  segment: string
  cwd: string
  target: SendTarget
  /** The first of the four checks it failed: never allowed, and unknown-destination unless `resolved`. */
  failure?: FailureCode
  /**
   * The target resolves despite `failure` (spec "Each send gets one
   * verdict"): its own words are literal, its shape is known, and it reads
   * no repository or cwd fact. A failed check then blocks only `allowed`.
   */
  resolved?: true
}

/** Repository facts the resolver read for one repository root (D4). */
export interface RepoFacts {
  root: string
  /** origin's url lines, for repository equality. */
  originUrls: readonly string[]
  /** Every remote's push targets: pushurl lines when present, else url lines. */
  remotes: ReadonlyMap<string, readonly string[]>
  /** The current branch's push remote: a name in `remotes`, or a URL. */
  pushRemote: string | null
  /**
   * The config holds something the parser will not follow — an include, an
   * insteadOf rewrite, a header it does not read exactly: no push resolves.
   */
  pinned?: string
  /** The config read failed; every git/gh target reads unknown-destination. */
  unreadable?: boolean
  /** The repository gh targets by default; origin when absent. */
  ghBase?: { remote: string } | { repo: string }
}

/** The destination classes D2's loader answers (hostnames by name only). */
export interface DestinationClasses {
  isInternal(host: string, port?: number): boolean
  isModelProvider(host: string): boolean
  isAllowedMcpServer(server: string): boolean
}

export interface JudgeFacts {
  destinations: DestinationClasses
  /** Repository facts by repository root; the longest root prefix matches a cwd. */
  repos: ReadonlyMap<string, RepoFacts>
}

export type Verdict = 'violation' | 'unknown-destination' | 'allowed'

export interface JudgedCandidate extends SendCandidate {
  verdict: Verdict
  /** Gated before storing: `github:origin`, `internal:<host>`, `unresolved:<code>`, … */
  destination: string
}

/** A candidate for one external MCP tool call (D5), which no command parses into. */
export function mcpCallCandidate(server: string, cwd: string, segment: string): SendCandidate {
  return { rule: 'mcp-call', segment, cwd, target: { kind: 'mcp', server } }
}

const STRENGTH: Record<Verdict, number> = { violation: 2, 'unknown-destination': 1, allowed: 0 }

/** The candidate a call's row keeps: strongest verdict, then rule order (D4). */
export function strongest(candidates: JudgedCandidate[]): JudgedCandidate | null {
  let best: JudgedCandidate | null = null
  for (const candidate of candidates) {
    if (best === null) { best = candidate; continue }
    const byVerdict = STRENGTH[candidate.verdict] - STRENGTH[best.verdict]
    if (byVerdict > 0 || (byVerdict === 0 && RULE_ORDER.indexOf(candidate.rule) < RULE_ORDER.indexOf(best.rule))) {
      best = candidate
    }
  }
  return best
}

/** The repository whose root most tightly contains `cwd`. */
function repoFor(cwd: string, facts: JudgeFacts): RepoFacts | undefined {
  let best: RepoFacts | undefined
  for (const repo of facts.repos.values()) {
    if (cwd !== repo.root && !cwd.startsWith(repo.root + '/')) continue
    if (best === undefined || repo.root.length > best.root.length) best = repo
  }
  return best
}

export interface ParsedGitUrl {
  host: string
  /** owner/repo without `.git`, for GitHub hosts; null otherwise. */
  repo: string | null
  port?: number
}

/**
 * A git URL in its https, ssh, git, or scp form, the userinfo and `.git`
 * dropped; null when the text is no URL. Kawai never resolves the name.
 */
export function parseGitUrl(text: string): ParsedGitUrl | null {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text)
  if (scheme) {
    try {
      const url = new URL(text)
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
      const host = url.hostname.toLowerCase()
      const repo = parts.length >= 2 ? `${parts[0]}/${parts[1].replace(/\.git$/, '')}` : null
      return { host, repo, ...(url.port ? { port: Number(url.port) } : {}) }
    } catch {
      return null
    }
  }
  const scp = /^([^@/\s]+)@([^:\s]+):(.+)$/.exec(text)
  if (scp) {
    const path = scp[3]!.replace(/^\/+|\/+$/g, '').split('/')
    return {
      host: scp[2]!.toLowerCase(),
      repo: path.length >= 2 ? `${path[0]}/${path[1].replace(/\.git$/, '')}` : null,
    }
  }
  return null
}

/** The origin's parsed URLs, for equality against a target URL. */
function originsOf(repo: RepoFacts): ParsedGitUrl[] {
  return repo.originUrls.map(originUrl => parseGitUrl(originUrl)).filter((parsed): parsed is ParsedGitUrl => parsed !== null)
}

/** A git URL judged: origin equality, then the host classes, else a violation. */
function judgeGitUrl(url: string, repo: RepoFacts | undefined, facts: JudgeFacts): Judgement {
  // An insteadOf rewrite can retarget even an explicit URL (round 5 R4).
  if (repo?.pinned !== undefined) return unknown(repo.unreadable === true ? 'facts-unreadable' : 'repo-config-pinned')
  const parsed = parseGitUrl(url)
  if (parsed === null) return unknown('target-not-url')
  const origins = repo === undefined ? [] : originsOf(repo)
  if (parsed.repo !== null && origins.some(origin => origin.repo === parsed.repo && origin.host === parsed.host)) {
    return { verdict: 'allowed', destination: 'github:origin' }
  }
  if (parsed.repo !== null && (parsed.host === 'github.com' || parsed.host === 'www.github.com')) {
    return { verdict: 'violation', destination: `github:${parsed.repo}` }
  }
  return judgeHost(parsed.host, facts, parsed.port)
}

interface Judgement {
  verdict: Verdict
  destination: string
}

const unknown = (code: UnresolvedCode): Judgement => ({ verdict: 'unknown-destination', destination: `unresolved:${code}` })

/** The repository facts every git and gh target needs, or the code they failed. */
function factsFailure(repo: RepoFacts | undefined): Judgement | null {
  if (repo === undefined) return unknown('no-repository')
  if (repo.unreadable === true) return unknown('facts-unreadable')
  if (repo.pinned !== undefined) return unknown('repo-config-pinned')
  return null
}

/** A bare host judged by the destination classes: internal, model provider, or out. */
function judgeHost(host: string, facts: JudgeFacts, port?: number): Judgement {
  if (facts.destinations.isInternal(host, port)) return { verdict: 'allowed', destination: `internal:${host}` }
  if (facts.destinations.isModelProvider(host)) return { verdict: 'allowed', destination: `model-provider:${host}` }
  return { verdict: 'violation', destination: `host:${host}` }
}

/** The URLs a push remote name resolves to (git pushes to every line). */
function pushUrlsFor(name: string, repo: RepoFacts): readonly string[] | null {
  if (parseGitUrl(name) !== null) return [name]
  return repo.remotes.get(name) ?? null
}

/** The strongest of several judgements — the worst target a push reaches. */
function strongestJudgement(judgements: Judgement[]): Judgement {
  return judgements.reduce((worst, next) => STRENGTH[next.verdict] > STRENGTH[worst.verdict] ? next : worst)
}

/** A push whose remote carries several URLs judges every one of them. */
function judgePushUrls(urls: readonly string[], repo: RepoFacts | undefined, facts: JudgeFacts): Judgement {
  return strongestJudgement(urls.map(url => judgeGitUrl(url, repo, facts)))
}

/** Judge one parsed candidate against the facts (D4). */
export function judge(candidate: SendCandidate, facts: JudgeFacts): JudgedCandidate {
  const judgement = candidate.failure === undefined ? judgeTarget(candidate, facts) : judgeFailed(candidate, candidate.failure, facts)
  return { ...candidate, verdict: judgement.verdict, destination: judgement.destination }
}

/** A candidate that failed a check: never allowed; a violation only when its target resolves anyway. */
function judgeFailed(candidate: SendCandidate, failure: FailureCode, facts: JudgeFacts): Judgement {
  if (candidate.resolved !== true) return unknown(failure)
  const judgement = judgeTarget(candidate, facts)
  return judgement.verdict === 'violation' ? judgement : unknown(failure)
}

/** A named repository against origin's: allowed only on an exact owner/repo and host match. */
function judgeRepo(named: string, host: string | undefined, repo: RepoFacts): Judgement {
  const origins = originsOf(repo)
  if (origins.length === 0) return unknown('origin-not-configured')
  const wanted = (host ?? origins[0]!.host).toLowerCase()
  if (origins.some(origin => named.toLowerCase() === origin.repo?.toLowerCase() && wanted === origin.host.toLowerCase())) {
    return { verdict: 'allowed', destination: 'github:origin' }
  }
  return { verdict: 'violation', destination: `github:${named}` }
}

function judgeTarget(candidate: SendCandidate, facts: JudgeFacts): Judgement {
  const { target } = candidate
  const repo = repoFor(candidate.cwd, facts)
  switch (target.kind) {
    case 'unresolved':
      return unknown(target.code)
    case 'mail':
      return { verdict: 'violation', destination: 'mail' }
    case 'mcp':
      return facts.destinations.isAllowedMcpServer(target.server)
        ? { verdict: 'allowed', destination: `mcp:${target.server}` }
        : { verdict: 'violation', destination: `mcp:${target.server}` }
    case 'registry': {
      const host = judgeHost(target.host, facts, target.port)
      if (host.verdict === 'violation') return { ...host, destination: `registry:${target.host}` }
      return host
    }
    case 'host':
      return judgeHost(target.host, facts, target.port)
    case 'url':
      return judgeGitUrl(target.url, repo, facts)
    case 'origin-implicit': {
      const failed = factsFailure(repo)
      if (failed !== null) return failed
      const urls = pushUrlsFor(repo!.pushRemote ?? 'origin', repo!)
      if (urls === null || urls.length === 0) return unknown('unknown-remote')
      return judgePushUrls(urls, repo, facts)
    }
    case 'remote': {
      const failed = factsFailure(repo)
      if (failed !== null) return failed
      const urls = repo!.remotes.get(target.name) ?? null
      if (urls === null || urls.length === 0) return unknown('unknown-remote')
      return judgePushUrls(urls, repo, facts)
    }
    case 'gh-default': {
      const failed = factsFailure(repo)
      if (failed !== null) return failed
      const base = repo!.ghBase ?? { remote: 'origin' }
      if ('repo' in base) return judgeRepo(base.repo, undefined, repo!)
      if (base.remote === 'origin' && repo!.originUrls.length === 0) return unknown('origin-not-configured')
      const urls = repo!.remotes.get(base.remote) ?? []
      if (urls.length === 0) return unknown('unknown-remote')
      return judgePushUrls(urls, repo, facts)
    }
    case 'repo': {
      const failed = factsFailure(repo)
      if (failed !== null) return failed
      // A fork publishes somewhere new: never origin, whatever it names (D1).
      if (target.fork === true) return { verdict: 'violation', destination: `github:${target.repo}` }
      return judgeRepo(target.repo, target.host, repo!)
    }
  }
}
