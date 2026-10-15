// The outbound classifier's judging half (execution-safety-recovery D4):
// pure verdicts over parsed send candidates. `judge` resolves one candidate's
// target against the destination classes (D2) and the repository facts the
// resolver read — origin's URL, every remote, the branch's push remote — and
// returns a verdict with a destination string. `strongest` reduces a call's
// candidates to its row: violation beats unknown-destination beats allowed,
// rule order breaking ties. Rule ids are append-only (contract E3) and
// `CLASSIFIER_VERSION` pins the rule set that judged a row, so a later rule
// change never rewrites history.

export const CLASSIFIER_VERSION = 1

export type OutboundRule =
  | 'git-push' | 'gh-write' | 'gh-api-write'
  | 'registry-publish' | 'http-send' | 'mail-send' | 'mcp-call'

/** E3: append-only; the order breaks verdict ties. */
export const RULE_ORDER: readonly OutboundRule[] = [
  'git-push', 'gh-write', 'gh-api-write', 'registry-publish', 'http-send', 'mail-send', 'mcp-call',
]

/** What a candidate sends to, before judging (D4). */
export type SendTarget =
  | { kind: 'origin-implicit' }
  | { kind: 'remote'; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'host'; host: string; port?: number }
  | { kind: 'registry'; host: string; port?: number }
  | { kind: 'repo'; repo: string; host?: string }
  | { kind: 'mail' }
  | { kind: 'mcp'; server: string }
  | { kind: 'unresolved'; why: string }

export interface SendCandidate {
  rule: OutboundRule
  /** The segment as reconstructed words; redacted before it is stored. */
  segment: string
  cwd: string
  target: SendTarget
}

/** Repository facts the resolver read for one repository root (D4). */
export interface RepoFacts {
  root: string
  originUrl: string | null
  remotes: ReadonlyMap<string, string>
  /** The current branch's push remote: a name in `remotes`, or a URL. */
  pushRemote: string | null
  /** The config read failed; every git/gh target reads unknown-destination. */
  unreadable?: boolean
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
  /** Redacted before storing: `github:origin`, `internal:<host>`, `unresolved:<why>`, … */
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

/** The origin's GitHub owner/repo, for equality against a target URL. */
function originOf(repo: RepoFacts): ParsedGitUrl | null {
  if (repo.originUrl === null) return null
  return parseGitUrl(repo.originUrl)
}

/** A git URL judged: origin equality, then the host classes, else a violation. */
function judgeGitUrl(url: string, repo: RepoFacts | undefined, facts: JudgeFacts): Judgement {
  const parsed = parseGitUrl(url)
  if (parsed === null) return { verdict: 'unknown-destination', destination: 'unresolved:the target did not parse as a URL' }
  const origin = repo === undefined ? null : originOf(repo)
  if (parsed.repo !== null && origin?.repo === parsed.repo && origin.host === parsed.host) {
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

/** A bare host judged by the destination classes: internal, model provider, or out. */
function judgeHost(host: string, facts: JudgeFacts, port?: number): Judgement {
  if (facts.destinations.isInternal(host, port)) return { verdict: 'allowed', destination: `internal:${host}` }
  if (facts.destinations.isModelProvider(host)) return { verdict: 'allowed', destination: `model-provider:${host}` }
  return { verdict: 'violation', destination: `host:${host}` }
}

/** The URL a push remote name or the branch's push remote resolves to. */
function pushUrlFor(name: string, repo: RepoFacts): string | null {
  const direct = parseGitUrl(name)
  if (direct !== null) return name
  return repo.remotes.get(name) ?? null
}

/** Judge one parsed candidate against the facts (D4). */
export function judge(candidate: SendCandidate, facts: JudgeFacts): JudgedCandidate {
  const judgement = judgeTarget(candidate, facts)
  return { ...candidate, verdict: judgement.verdict, destination: judgement.destination }
}

function judgeTarget(candidate: SendCandidate, facts: JudgeFacts): Judgement {
  const { target } = candidate
  const repo = repoFor(candidate.cwd, facts)
  switch (target.kind) {
    case 'unresolved':
      return { verdict: 'unknown-destination', destination: `unresolved:${target.why}` }
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
      if (repo === undefined) return { verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd' }
      if (repo.unreadable) return { verdict: 'unknown-destination', destination: 'unresolved:the facts read failed' }
      const name = repo.pushRemote ?? 'origin'
      const url = pushUrlFor(name, repo)
      if (url === null) {
        return { verdict: 'unknown-destination', destination: `unresolved:remote ${name} is not configured` }
      }
      return judgeGitUrl(url, repo, facts)
    }
    case 'remote': {
      if (repo === undefined) return { verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd' }
      if (repo.unreadable) return { verdict: 'unknown-destination', destination: 'unresolved:the facts read failed' }
      const url = repo.remotes.get(target.name) ?? null
      if (url === null) {
        return { verdict: 'unknown-destination', destination: `unresolved:remote ${target.name} is not configured` }
      }
      return judgeGitUrl(url, repo, facts)
    }
    case 'repo': {
      if (repo === undefined) return { verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd' }
      if (repo.unreadable) return { verdict: 'unknown-destination', destination: 'unresolved:the facts read failed' }
      const origin = originOf(repo)
      if (origin?.repo == null) {
        return { verdict: 'unknown-destination', destination: 'unresolved:origin is not configured' }
      }
      // `{owner}`/`{repo}` mean origin; the gh default host follows origin's.
      const name = target.repo === '{owner}/{repo}' ? origin.repo : target.repo
      const host = (target.host ?? origin.host).toLowerCase()
      if (name.toLowerCase() === origin.repo.toLowerCase() && host === origin.host.toLowerCase()) {
        return { verdict: 'allowed', destination: 'github:origin' }
      }
      return { verdict: 'violation', destination: `github:${name}` }
    }
  }
}
