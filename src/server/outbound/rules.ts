// The rules table's dispatch (execution-safety-recovery D4): one unwrapped
// command's head picks its rule — git, gh, the registry tools, curl, wget,
// httpie, and the mail tools — or a listed read-only head that can never
// send. Anything else is unmodeled, and the backstop searches it. Each rule
// reads argument positions and flags against its own option table; message,
// title, and body values are never targets. Pure.
import { NON_SEND, UNMODELED, type RuleInput, type RuleResult } from './proof'
import { ghRule } from './toolsGh'
import { gitRule } from './toolsGit'
import { curlRule, httpieRule, mailRule, wgetRule } from './toolsHttp'
import { buildctlRule, cargoRule, dockerRule, helmRule, npmRule, twineRule } from './toolsRegistry'

const RULES: Record<string, (input: RuleInput) => RuleResult> = {
  git: gitRule,
  gh: ghRule,
  curl: curlRule,
  wget: wgetRule,
  http: httpieRule,
  https: httpieRule,
  npm: npmRule,
  pnpm: npmRule,
  yarn: npmRule,
  bun: npmRule,
  twine: twineRule,
  cargo: cargoRule,
  docker: dockerRule,
  podman: dockerRule,
  buildctl: buildctlRule,
  helm: helmRule,
}

/**
 * Heads that read, print, or edit local files and never run another command
 * or open a connection. `find`, `sed`, `awk`, `sort`, `tar`, `xargs`, and
 * the interpreters are absent on purpose: each can run a program.
 */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'echo', 'printf', 'cut', 'tr', 'diff', 'cmp', 'mkdir', 'rmdir',
  'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'true',
  'false', 'test', '[', 'date', 'sleep', 'uniq', 'tee', 'jq', 'yq', 'du', 'df', 'tree', 'which', 'whoami', 'id', 'uname',
  'hostname', 'printenv', 'nl', 'paste', 'comm', 'join', 'fold', 'fmt', 'column', 'rev', 'tac', 'od', 'xxd',
  'hexdump', 'base64', 'sha256sum', 'sha1sum', 'md5sum', 'shasum', 'seq', 'expr', 'less', 'more', 'type',
  'exit', 'return', ':', 'wait', 'jobs', 'kill', 'ps', 'pgrep', 'lsof', 'free', 'uptime', 'nproc', 'yes', 'clear',
])

/** `rg` reads unless a preprocessor command is named. */
const rgRule = (input: RuleInput): RuleResult =>
  input.args.some(word => word.text.startsWith('--pre')) ? UNMODELED : NON_SEND

/** The rule result for one unwrapped command whose words are all literal-or-not as given. */
export function ruleFor(input: RuleInput): RuleResult {
  const mail = mailRule(input)
  if (mail !== null) return mail
  const rule = RULES[input.name]
  if (rule !== undefined) return rule(input)
  if (input.name === 'rg') return rgRule(input)
  return READ_ONLY.has(input.name) ? NON_SEND : UNMODELED
}
