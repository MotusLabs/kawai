// The four checks `allowed` needs (execution-safety-recovery D4, task
// revision 3), as fixed failure codes. A candidate that fails any check reads
// `unknown-destination` with destination `unresolved:<code>`, where the code
// is the first failing check's — never text from the command. Check order:
// 1 literal words, 2 known shape, 3 proven context, 4 exact facts (pins and
// the judge-time facts read). Backstop rows carry `unclassified:<entry>`.
// Pure.
import type { OutboundRule, SendTarget } from './classify'
import type { Word } from './tokenize'

const CHECKS = {
  // 1. Literal words.
  'not-literal': 1,
  // 2. Known shape.
  'unknown-option': 2,
  'extra-argument': 2,
  'unknown-command-path': 2,
  'xargs-arguments': 2,
  'options-file': 2,
  'unparsed-output': 2,
  'url-glob': 2,
  // 3. Proven context.
  'subshell-or-group': 3,
  'compound-command': 3,
  'unevaluated-builtin': 3,
  'expansion-assignment': 3,
  'inexact-cwd': 3,
  // 4. Exact facts: pins the parser sees, then the judge's facts read.
  'environment-pin': 4,
  'git-config-override': 4,
  'config-changed': 4,
  'connection-redirected': 4,
  'submodule-push': 4,
  'registry-name': 4,
  'no-repository': 4,
  'facts-unreadable': 4,
  'repo-config-pinned': 4,
  'unknown-remote': 4,
  'origin-not-configured': 4,
  'target-not-url': 4,
  'no-url': 4,
  'api-path-not-repo': 4,
} as const

export type FailureCode = keyof typeof CHECKS

/** The backstop's fixed, append-only list (D4); `<entry>` names one, never command text. */
export const BACKSTOP_ENTRIES = [
  'git-push', 'gh', 'curl', 'wget', 'http', 'https', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'socat', 'ftp', 'telnet',
  'mail', 'publish', 'image-push', 'url', 'command-not-literal', 'dev-tcp',
] as const
export type BackstopEntry = typeof BACKSTOP_ENTRIES[number]

/** What `unresolved:` carries: a failure code, or a backstop entry. */
export type UnresolvedCode = FailureCode | `unclassified:${BackstopEntry}`

/** The first failing check's code (lowest check; the earlier code within one). */
export function firstFailure(codes: readonly FailureCode[]): FailureCode | undefined {
  let best: FailureCode | undefined
  for (const code of codes) {
    if (best === undefined || CHECKS[code] < CHECKS[best]) best = code
  }
  return best
}

/** One send a rule found in a segment, with the checks it already failed. */
export interface RuleSend {
  rule: OutboundRule
  target: SendTarget
  failures: FailureCode[]
}

/**
 * What a rule makes of one unwrapped command: sends (with any per-command
 * directory change, `git -C`), a proven non-send (with any repository
 * config it changes for later segments), or unmodeled — the backstop's.
 */
export type RuleResult =
  | { kind: 'sends'; sends: RuleSend[]; chdir?: Word[] }
  | { kind: 'non-send'; changes?: 'remotes' | 'branch' }
  | { kind: 'unmodeled' }

export const NON_SEND: RuleResult = { kind: 'non-send' }
export const UNMODELED: RuleResult = { kind: 'unmodeled' }

/** A send result with one target. */
export const send = (rule: OutboundRule, target: SendTarget, failures: FailureCode[] = []): RuleResult =>
  ({ kind: 'sends', sends: [{ rule, target, failures }] })

export const unresolved = (code: UnresolvedCode): SendTarget => ({ kind: 'unresolved', code })

/** The words a rule reads, with the facts about how it was invoked. */
export interface RuleInput {
  /** The command's basename, lowercase. */
  name: string
  args: Word[]
  /** stdin is redirected or piped in (httpie then sends it as a body). */
  stdin: boolean
}
