// The `git` rule (execution-safety-recovery D4): global options in every
// spelling, `git push` with its option table, and the subcommands that are
// proven non-sends. `-C` moves the command's cwd; `-c`, `--config-env`,
// `--git-dir`, `--work-tree`, `--namespace`, and `--exec-path` change what
// the repository facts mean, so a push under any of them fails the facts
// check. A subcommand that can run another command (`rebase --exec`,
// `submodule foreach`, `bisect run`, a pager or upload-pack override) is
// never a proven non-send. Pure.
import { scanOptions, table, valuesOf, hasOption } from './options'
import { NON_SEND, send, UNMODELED, unresolved, type FailureCode, type RuleInput, type RuleResult } from './proof'
import { gitRepositoryTarget, SCPISH, URLISH } from './targets'

const GLOBAL = table(
  '-p --paginate -P --no-pager --no-replace-objects --bare --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-advice --version -v -h --help',
  '-C -c --git-dir --work-tree --namespace --config-env --super-prefix --attr-source --list-cmds',
  '--exec-path',
)
/** Global options that change what the read facts mean. */
const OVERRIDES = ['-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--attr-source']

const PUSH = table(
  '--all --branches --mirror --tags --follow-tags --no-follow-tags --atomic --no-atomic -n --dry-run --porcelain -d --delete ' +
  '-f --force --force-if-includes --no-force-if-includes --prune --no-prune -v --verbose -q --quiet -u --set-upstream ' +
  '--thin --no-thin --progress --no-progress --no-verify --verify --no-signed -4 --ipv4 -6 --ipv6 --no-recurse-submodules',
  '--repo -o --push-option --receive-pack --exec --recurse-submodules',
  '--force-with-lease --signed',
)

/** Subcommands that never send by themselves, whatever literal options they take. */
const SAFE = new Set([
  'status', 'log', 'diff', 'show', 'add', 'commit', 'checkout', 'switch', 'branch', 'tag', 'fetch', 'pull', 'merge', 'reset',
  'restore', 'rm', 'mv', 'stash', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'ls-tree', 'remote', 'config', 'init',
  'clone', 'worktree', 'cherry-pick', 'revert', 'describe', 'blame', 'shortlog', 'grep', 'reflog', 'clean', 'apply',
  'format-patch', 'notes', 'show-ref', 'symbolic-ref', 'cat-file', 'for-each-ref', 'merge-base', 'name-rev', 'version',
  'help', 'gc', 'prune', 'fsck', 'count-objects', 'sparse-checkout', 'range-diff', 'whatchanged', 'update-index',
  'hash-object', 'write-tree', 'read-tree', 'commit-tree', 'update-ref', 'check-ignore', 'check-attr', 'var', 'diff-tree',
  'diff-index', 'diff-files', 'cherry', 'maintenance', 'repack', 'pack-refs', 'verify-commit', 'verify-tag', 'bundle',
])
/** Config sections that never change where a push or gh command goes. */
const SAFE_KEYS = /^(user|color|commit|gpg|tag|init|advice|diff|merge|rerere|log|format|status|help|i18n|pull|fetch|rebase)\./i
/** Options through which a safe subcommand runs another program. */
const RUNS_PROGRAM = /^(--upload-pack|--exec|--receive-pack|--open-files-in-pager|-O|--ext-diff|--textconv|--template|-u$|--config)/

/** The `git` rule over one unwrapped command. */
export function gitRule(input: RuleInput): RuleResult {
  const { args } = input
  const global = scanOptions(args, 0, GLOBAL, true)
  if (global.unknown !== null || global.opaque) return UNMODELED
  const subWord = args[global.end]
  if (subWord === undefined) return NON_SEND
  if (!subWord.literal) return send('git-push', unresolved('not-literal'), ['not-literal'])
  const sub = subWord.text
  const overridden = hasOption(global, ...OVERRIDES)
  const chdir = valuesOf(global, '-C')
  if (sub === 'push') {
    const failures: FailureCode[] = []
    if (overridden) failures.push('git-config-override')
    const pushed = scanOptions(args, global.end + 1, PUSH)
    if (pushed.unknown !== null) failures.push('unknown-option')
    if (pushed.opaque) failures.push('not-literal')
    if (hasOption(pushed, '--receive-pack', '--exec')) failures.push('connection-redirected')
    const recurse = valuesOf(pushed, '--recurse-submodules')
    if (recurse.some(value => value.text !== 'no' && value.text !== 'check')) failures.push('submodule-push')
    const repoFlag = valuesOf(pushed, '--repo')[0]
    const first = repoFlag ?? pushed.positionals[0]
    let target
    if (first === undefined) target = { kind: 'origin-implicit' } as const
    else if (repoFlag === undefined && isRefspec(first.text)) target = { kind: 'origin-implicit' } as const
    else target = gitRepositoryTarget(first.text)
    return { kind: 'sends', sends: [{ rule: 'git-push', target, failures }], chdir }
  }
  // Global overrides can point a pager, hook path, or alias at a program.
  if (overridden || !SAFE.has(sub)) return UNMODELED
  const rest = args.slice(global.end + 1)
  if (rest.some(word => !word.literal)) return UNMODELED
  if (rest.some(word => RUNS_PROGRAM.test(word.text)) && sub !== 'add' && sub !== 'branch') return UNMODELED
  return { kind: 'non-send', ...changesOf(sub, rest.map(word => word.text)) }
}

/** A push's first positional that is a refspec, not a repository. */
function isRefspec(text: string): boolean {
  if (text.startsWith('+') || text.startsWith('refs/') || text === 'HEAD') return true
  return text.includes(':') && !URLISH.test(text) && !SCPISH.test(text)
}

/**
 * What a non-send changes for later segments of the call: a remote or url
 * config write makes every later git and gh target stale; a branch switch or
 * upstream change makes a later implicit push stale.
 */
function changesOf(sub: string, rest: string[]): { changes?: 'remotes' | 'branch' } {
  if (sub === 'config') {
    const positionals = rest.filter(word => !word.startsWith('-'))
    const read = rest.some(word => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--show-origin|--show-scope)$/.test(word)) ||
      positionals[0] === 'get' || positionals[0] === 'list' || (positionals.length === 1 && !rest.some(word => word.startsWith('--')))
    if (read) return {}
    // Writes to keys that never name a destination leave the facts current.
    const key = positionals.find(word => word !== 'set' && word !== 'unset' && word !== 'add')
    return key !== undefined && SAFE_KEYS.test(key) ? {} : { changes: 'remotes' }
  }
  if (sub === 'remote') {
    const verb = rest.find(word => !word.startsWith('-'))
    return verb === undefined || verb === 'show' || verb === 'get-url' || verb === 'prune' || verb === 'update' ? {} : { changes: 'remotes' }
  }
  if (sub === 'clone' || sub === 'init') return { changes: 'remotes' }
  if (sub === 'checkout' || sub === 'switch' || sub === 'worktree') return { changes: 'branch' }
  if (sub === 'branch' && rest.some(word => /^(-u|--set-upstream-to|--unset-upstream|-m|-M|--move)/.test(word))) return { changes: 'branch' }
  return {}
}
