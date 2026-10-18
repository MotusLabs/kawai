// The `gh-write` and `gh-api-write` rules (execution-safety-recovery D4):
// one option table per `gh <command> <verb>`, because flag arities differ
// across verbs (`-m` is `--milestone` for `pr create` and `--merge` for `pr
// merge`; `-d` is `--draft` or `--delete-branch`), plus each verb's
// positional count. A write's target is `-R`/`--repo`, a URL positional, a
// repo verb's positional, or gh's default repository; `repo create`/`fork`
// and gists never fall back to it (D1). Reads listed here are proven
// non-sends; `repo set-default`, `auth`, and `config` change what a later
// gh command targets. Every other gh command is the backstop's. Pure.
import { hasOption, merge, scanOptions, table, valuesOf, type OptionTable } from './options'
import { NON_SEND, UNMODELED, unresolved, type FailureCode, type RuleInput, type RuleResult } from './proof'
import { ghApiTarget, ghRepoCreationTarget, ghRepoForkTarget, ghRepoTarget, type GhTargetKind } from './ghTargets'

const COMMON = table('', '-R --repo')
const BODY = table('', '-b --body -F --body-file')
const EDIT = table('', '-t --title -b --body -F --body-file -B --base --add-assignee --remove-assignee --add-label --remove-label --add-reviewer --remove-reviewer --add-project --remove-project -m --milestone')
const COMMENT = merge(BODY, table('-e --editor -w --web --edit-last --create-if-none --delete-last --yes'))
const CREATE = table(
  '-d --draft -f --fill --fill-first --fill-verbose -w --web --dry-run --no-maintainer-edit -e --editor',
  '-t --title -b --body -F --body-file -B --base -H --head -a --assignee -l --label -m --milestone -p --project -r --reviewer -T --template --recover',
)
const ISSUE_CREATE = table('-w --web -e --editor', '-t --title -b --body -F --body-file -a --assignee -l --label -m --milestone -p --project -T --template --recover')

interface Verb {
  options: OptionTable
  /** The most positionals the verb takes; Infinity for file lists. */
  max: number
  target: GhTargetKind
}

const verb = (options: OptionTable, max: number, target: GhTargetKind = 'default'): Verb => ({ options: merge(COMMON, options), max, target })

const WRITES: Record<string, Verb> = {
  'pr create': verb(CREATE, 0),
  'pr merge': verb(table('-m --merge -r --rebase -s --squash -d --delete-branch --auto --disable-auto --admin', '-b --body -F --body-file -t --subject -A --author-email --match-head-commit'), 1),
  'pr comment': verb(COMMENT, 1),
  'pr edit': verb(merge(EDIT, table('--remove-milestone')), 1),
  'pr close': verb(table('-d --delete-branch', '-c --comment'), 1),
  'pr reopen': verb(table('', '-c --comment'), 1),
  'pr review': verb(table('-a --approve -c --comment -r --request-changes', '-b --body -F --body-file'), 1),
  'pr ready': verb(table('--undo'), 1),
  'pr lock': verb(table('', '-r --reason'), 1),
  'pr unlock': verb(table(''), 1),
  'issue create': verb(ISSUE_CREATE, 0),
  'issue comment': verb(COMMENT, 1),
  'issue edit': verb(merge(EDIT, table('--remove-milestone')), 1),
  'issue close': verb(table('', '-c --comment -r --reason'), 1),
  'issue reopen': verb(table('', '-c --comment'), 1),
  'issue delete': verb(table('--yes'), 1),
  'issue transfer': verb(table(''), 2, 'transfer'),
  'issue lock': verb(table('', '-r --reason'), 1),
  'issue unlock': verb(table(''), 1),
  'issue pin': verb(table(''), 1),
  'issue unpin': verb(table(''), 1),
  'issue develop': verb(table('-c --checkout -l --list', '-b --base -n --name --issue-repo --branch-repo'), 1),
  'release create': verb(table('-d --draft -p --prerelease --generate-notes --verify-tag --fail-on-no-commits', '-t --title -n --notes -F --notes-file --target --notes-start-tag --notes-from-tag --discussion-category', '--latest'), Infinity),
  'release upload': verb(table('--clobber'), Infinity),
  'release edit': verb(table('--verify-tag', '-t --title -n --notes -F --notes-file --tag --target --discussion-category', '--draft --prerelease --latest'), 1),
  'release delete': verb(table('-y --yes --cleanup-tag'), 1),
  'release delete-asset': verb(table('-y --yes'), 2),
  'repo create': verb(table('--public --private --internal --push --clone -c --disable-issues --disable-wiki --include-all-branches --add-readme', '-d --description -h --homepage -t --team -p --template -g --gitignore -l --license -s --source -r --remote'), 1, 'create'),
  'repo fork': verb(table('--clone --remote --default-branch-only', '--org --fork-name --remote-name'), 1, 'fork'),
  'repo delete': verb(table('--yes'), 1, 'repo-positional'),
  'repo archive': verb(table('-y --yes'), 1, 'repo-positional'),
  'repo unarchive': verb(table('-y --yes'), 1, 'repo-positional'),
  'repo rename': verb(table('-y --yes'), 1),
  'repo sync': verb(table('--force', '-b --branch -s --source'), 1, 'repo-positional'),
  'repo edit': verb(table('--accept-visibility-change-consequences', '-d --description -h --homepage --default-branch --visibility --add-topic --remove-topic',
    '--enable-issues --enable-wiki --enable-projects --enable-discussions --enable-merge-commit --enable-squash-merge --enable-rebase-merge --enable-auto-merge --delete-branch-on-merge --allow-forking --allow-update-branch --template'), 1, 'repo-positional'),
  'gist create': verb(table('-p --public -w --web', '-d --desc -f --filename'), Infinity, 'gist'),
  'gist edit': verb(table('', '-a --add -d --desc -f --filename -r --remove'), 2, 'gist'),
  'gist delete': verb(table('--yes'), 1, 'gist'),
  'label create': verb(table('-f --force', '-c --color -d --description'), 1),
  'label edit': verb(table('', '-c --color -d --description -n --name'), 1),
  'label delete': verb(table('--yes'), 1),
  'label clone': verb(table('-f --force'), 1),
  'secret set': verb(table('--no-store --no-repos-selected', '-b --body -f --env-file -e --env -o --org -u --user -a --app -v --visibility -r --repos'), 1, 'account'),
  'secret delete': verb(table('', '-e --env -o --org -u --user -a --app'), 1, 'account'),
  'variable set': verb(table('', '-b --body -f --env-file -e --env -o --org -v --visibility -r --repos'), 1, 'account'),
  'variable delete': verb(table('', '-e --env -o --org'), 1, 'account'),
  'workflow run': verb(table('--json', '-r --ref -f --raw-field -F --field'), 1),
  'workflow enable': verb(table(''), 1),
  'workflow disable': verb(table(''), 1),
  'run cancel': verb(table(''), 1),
  'run rerun': verb(table('--failed -d --debug', '-j --job'), 1),
  'run delete': verb(table(''), 1),
  'cache delete': verb(table('-a --all'), 1),
}

/** gh commands that only read. */
const READS = new Set([
  'pr view', 'pr list', 'pr status', 'pr diff', 'pr checks', 'pr checkout', 'issue view', 'issue list', 'issue status',
  'repo view', 'repo list', 'repo clone', 'release view', 'release list', 'release download', 'run view', 'run list', 'run watch',
  'run download', 'workflow view', 'workflow list', 'gist view', 'gist list', 'gist clone', 'label list', 'secret list',
  'variable list', 'variable get', 'cache list', 'search repos', 'search issues', 'search prs', 'search code', 'search commits',
  'auth status', 'extension list', 'ruleset list', 'ruleset view', 'ruleset check', 'org list', 'browse', 'status', 'version', 'help',
])
/** gh commands that change which repository later gh commands target. */
const RETARGETS = /^(repo set-default|auth |config )/

const API = table(
  '-i --include --paginate --slurp --silent --verbose -h --help',
  '-X --method -f --raw-field -F --field --input -H --header -q --jq -t --template --cache -p --preview --hostname',
)

/** `gh api`: a write when its method is not GET, or it sends fields or input without one. */
function apiRule(input: RuleInput): RuleResult {
  const scanned = scanOptions(input.args, 1, API, false, true)
  const method = valuesOf(scanned, '-X', '--method')[0]
  const fields = hasOption(scanned, '-f', '--raw-field', '-F', '--field', '--input')
  if (scanned.unknown !== null) return UNMODELED
  const failures: FailureCode[] = []
  if (scanned.opaque || method?.literal === false) failures.push('not-literal')
  const upper = method?.text.toUpperCase()
  const writes = upper !== undefined ? upper !== 'GET' && upper !== 'HEAD' : fields
  if (!writes) return failures.length > 0 ? UNMODELED : NON_SEND
  if (scanned.positionals.length > 1) failures.push('extra-argument')
  const host = valuesOf(scanned, '--hostname')[0]
  return { kind: 'sends', sends: [{ rule: 'gh-api-write', target: ghApiTarget(scanned.positionals[0], host), failures }] }
}

/** The gh rule over one unwrapped command. */
export function ghRule(input: RuleInput): RuleResult {
  const [command, verbWord] = input.args
  if (command === undefined) return NON_SEND
  if (!command.literal || (verbWord !== undefined && !verbWord.literal)) {
    return { kind: 'sends', sends: [{ rule: 'gh-write', target: unresolved('not-literal'), failures: ['not-literal'] }] }
  }
  if (command.text === 'api') return apiRule(input)
  const key = verbWord === undefined ? command.text : `${command.text} ${verbWord.text}`
  const spec = WRITES[key]
  if (spec === undefined) {
    if (RETARGETS.test(`${key} `)) return { kind: 'non-send', changes: 'remotes' }
    const known = READS.has(key) || READS.has(command.text)
    return known && input.args.every(word => word.literal) ? NON_SEND : UNMODELED
  }
  const scanned = scanOptions(input.args, 2, spec.options, false, true)
  const failures: FailureCode[] = []
  if (scanned.unknown !== null) failures.push('unknown-option')
  if (scanned.opaque) failures.push('not-literal')
  if (scanned.positionals.length > spec.max) failures.push('extra-argument')
  const target = spec.target === 'create' ? ghRepoCreationTarget(scanned)
    : spec.target === 'fork' ? ghRepoForkTarget(scanned)
      : ghRepoTarget(scanned, spec.target)
  return { kind: 'sends', sends: [{ rule: 'gh-write', target, failures }] }
}
