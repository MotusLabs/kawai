// The outbound classifier's matching half (execution-safety-recovery D4,
// task revision 3): `parseSends` walks one Bash call's simple commands,
// carrying the call's state (`callState.ts`), unwraps each, and asks the
// rules table (`rules.ts`) what it is. A send becomes a candidate that
// records the first of the four checks it fails — literal words, known
// shape, proven context, exact facts — so `judge` can only reach `allowed`
// for a fully proved send. A command that is neither a candidate nor a
// proven non-send goes to the backstop, which names the list entries its
// text holds. One `bash -c` level is walked with the call's state; deeper
// nesting is the backstop's. Pure.
import { backstopEntries, toolEntry } from './backstop'
import { BUILTINS, childState, evaluateBuiltin, initialState, pinsEnvironment, resolveDir, type CallState, type Cwd } from './callState'
import type { SendCandidate } from './classify'
import { firstFailure, unresolved, type BackstopEntry, type FailureCode, type RuleResult } from './proof'
import { ruleFor } from './rules'
import { parseCall, type SimpleCommand } from './segments'
import { basename, unwrap, type Wrapped } from './unwrapping'
import type { Word } from './tokenize'

export interface ParseOptions {
  /** The server's home directory: `~` and a bare `cd` read as it. */
  home?: string
}

/** Above this length only the backstop reads a command (the precise walk stays bounded). */
export const PRECISE_MAX = 262_144

/** Standard directories an absolute command path may name. */
const STANDARD_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$|^\/snap\/bin\/[^/]+$/
/** Wrappers that run their command as a separate process. */
const EXTERNAL_WRAPPERS = new Set(['env', 'sudo', 'doas', 'timeout', 'nice', 'nohup', 'stdbuf', 'ionice', 'xargs'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
/** Expansions that can assign in the current shell. */
const ASSIGNING = /\$\{|\$\(\(|\$\[/

/** Parse a whole command into its send candidates (D4). */
export function parseSends(command: string, cwd: string, options: ParseOptions = {}): SendCandidate[] {
  if (command.length > PRECISE_MAX) {
    return backstopEntries(command).map(entry => unclassified(entry, command.slice(0, 4096), cwd))
  }
  const state = initialState(cwd, options.home)
  return walk(command, state, [], 0, options)
}

/** Failures a nested script inherits from the command that runs it. */
type Inherited = FailureCode[]

function walk(script: string, state: CallState, inherited: Inherited, depth: number, options: ParseOptions): SendCandidate[] {
  const call = parseCall(script, options)
  const candidates: SendCandidate[] = []
  const callFailures: FailureCode[] = [...inherited]
  if (call.grouped) callFailures.push('subshell-or-group')
  if (call.compound) callFailures.push('compound-command')
  const pipelineSize = new Map<number, number>()
  for (const cmd of call.commands) pipelineSize.set(cmd.pipeline, (pipelineSize.get(cmd.pipeline) ?? 0) + 1)
  let previous: string | null = null
  // The directory state outside each open subshell, restored when it closes.
  const outside: Pick<CallState, 'cwd' | 'stack' | 'cdSeen'>[] = []
  for (let index = 0; index < call.commands.length; index++) {
    const cmd = call.commands[index]!
    while (outside.length < cmd.subshell) outside.push({ cwd: state.cwd, stack: [...state.stack], cdSeen: state.cdSeen })
    while (outside.length > cmd.subshell) Object.assign(state, outside.pop())
    // A cd's effect holds for a later command only through an `&&` chain.
    if (index > 0 && state.cdSeen && previous !== '&&') state.cwd = { ...state.cwd, certain: false }
    const inPipeline = (pipelineSize.get(cmd.pipeline) ?? 1) > 1
    const counts = !inPipeline && previous !== '||' && cmd.connector !== '&'
    const stdin = cmd.redirects.some(redirect => redirect.op.includes('<') && !redirect.op.includes('>')) ||
      (index > 0 && (previous === '|' || previous === '|&'))
    const siblings = call.commands.filter(other => other.pipeline === cmd.pipeline)
    const segment = new Segment(cmd, siblings, state, callFailures, counts, stdin)
    candidates.push(...segment.classify(depth, options))
    if (cmd.words.some(word => !word.literal && ASSIGNING.test(word.text))) state.context.add('expansion-assignment')
    previous = cmd.connector
  }
  return candidates
}

const unclassified = (entry: BackstopEntry, segment: string, cwd: string): SendCandidate =>
  ({ rule: 'unclassified-send', segment, cwd, target: unresolved(`unclassified:${entry}`) })

/** One simple command, classified against the call's state. */
class Segment {
  constructor(
    private readonly cmd: SimpleCommand,
    private readonly siblings: SimpleCommand[],
    private readonly state: CallState,
    private readonly callFailures: FailureCode[],
    private readonly counts: boolean,
    private readonly stdin: boolean,
  ) {}

  classify(depth: number, options: ParseOptions): SendCandidate[] {
    const { cmd, state } = this
    const networkRedirect = cmd.redirects.some(redirect => /^\/dev\/(tcp|udp)\//.test(redirect.target?.text ?? ''))
    if (cmd.words.length === 0) return networkRedirect ? this.backstop() : []
    const unwrapped = unwrap(cmd.words)
    // A command word that is not literal may name a builtin (`cd`, `eval`).
    if (!cmd.words[0]!.literal) state.context.add('unevaluated-builtin')
    if (unwrapped.kind === 'unmodeled') {
      if (BUILTINS.has(basename(cmd.words[0]!.text))) state.context.add('unevaluated-builtin')
      // A word the parser could not place may be the command itself.
      return this.backstop(cmd.words.some(word => !word.literal) ? ['command-not-literal'] : [])
    }
    // `exec` replaces the shell; anything it does is unevaluated for later commands.
    if (unwrapped.wrappers.includes('exec')) state.context.add('unevaluated-builtin')
    if (unwrapped.kind === 'assignments') {
      for (const name of unwrapped.assigned) state.assigned.add(name)
      return networkRedirect ? this.backstop() : []
    }
    if (unwrapped.kind === 'query') return networkRedirect ? this.backstop() : []
    const cwd = this.effectiveCwd(state.cwd, unwrapped.chdir)
    if (unwrapped.kind === 'shell') {
      if (depth > 0 || !unwrapped.script.literal) return this.backstop(unwrapped.script.literal ? [] : ['command-not-literal'])
      const inherited = [...this.callFailures, ...this.segmentFailures(unwrapped, null)]
      const child = childState(state, cwd, unwrapped.assigned)
      const inner = walk(unwrapped.script.text, child, inherited, depth + 1, options)
      // The script's shell state stays inside it; its repository writes do not.
      state.remotesChanged ||= child.remotesChanged
      state.branchChanged ||= child.branchChanged
      return inner
    }
    const head = unwrapped.head
    if (!head.literal) {
      state.context.add('unevaluated-builtin')
      return this.backstop(['command-not-literal'])
    }
    const name = basename(head.text)
    const inShell = unwrapped.wrappers.every(wrapper => !EXTERNAL_WRAPPERS.has(wrapper))
    const builtin = inShell && !head.text.includes('/') ? evaluateBuiltin(state, name, unwrapped.args, this.counts) : null
    // An unevaluated builtin (`eval`, `source`, …) may run anything its words name.
    if (builtin === 'unevaluated') return this.backstop()
    if (builtin === 'exact') return networkRedirect ? this.backstop() : []
    const result = ruleFor({ name, args: unwrapped.args, stdin: this.stdin })
    this.noteChanges(name, unwrapped.args, result)
    // A send tool the rule could not prove may be sending: a non-literal word can hide its verb.
    const hidden = cmd.words.some(word => !word.literal) ? toolEntry(name) : null
    const tool = hidden === null ? [] : [hidden]
    if (result.kind === 'unmodeled' || networkRedirect) return this.backstop(tool)
    const failures = this.segmentFailures(unwrapped, head)
    if (result.kind === 'non-send') {
      // A proven non-send: listed, every word literal, a standard head, no environment pin.
      const unproven = failures.some(code => code === 'not-literal' || code === 'unknown-command-path' || code === 'environment-pin')
      return unproven ? this.backstop(tool) : []
    }
    const sendCwd = this.effectiveCwd(cwd, result.chdir ?? [])
    return result.sends.map(found => {
      const pins: FailureCode[] = []
      const gitOrGh = found.rule === 'git-push' || found.rule === 'gh-write' || found.rule === 'gh-api-write'
      if (gitOrGh && state.remotesChanged) pins.push('config-changed')
      if (found.rule === 'git-push' && found.target.kind === 'origin-implicit' && state.branchChanged) pins.push('config-changed')
      if (!sendCwd.certain) pins.push('inexact-cwd')
      const failure = firstFailure([...failures, ...this.callFailures, ...state.context, ...found.failures, ...pins])
      return { rule: found.rule, segment: cmd.text, cwd: sendCwd.dir, target: found.target, ...(failure === undefined ? {} : { failure }) }
    })
  }

  /** The literal, shape, and environment checks one command's own words decide. */
  private segmentFailures(wrapped: Wrapped, head: Word | null): FailureCode[] {
    const failures: FailureCode[] = []
    const words = [...this.cmd.words, ...this.cmd.redirects.flatMap(redirect => redirect.target === null ? [] : [redirect.target])]
    const unquotedHeredoc = this.cmd.redirects.some(redirect => redirect.heredoc !== undefined && !redirect.heredoc.quoted)
    if (words.some(word => !word.literal) || unquotedHeredoc) failures.push('not-literal')
    // The command word and, under wrappers, the wrapped head: either may be any program.
    const first = this.cmd.words.find(word => !(word.literal && ASSIGNMENT.test(word.text)))
    const heads = [first, head].filter((word): word is Word => word !== undefined && word !== null)
    if (heads.some(word => word.text.includes('/') && !STANDARD_BIN.test(word.text))) failures.push('unknown-command-path')
    if (wrapped.wrappers.includes('xargs')) failures.push('xargs-arguments')
    if (wrapped.cleared || wrapped.unset.length > 0 || pinsEnvironment([...this.state.assigned, ...wrapped.assigned])) failures.push('environment-pin')
    return failures
  }

  /** The directory after per-command changes (`env -C`, `sudo -D`, `git -C`). */
  private effectiveCwd(base: Cwd, changes: Word[]): Cwd {
    return changes.reduce((dir, word) => resolveDir(dir, word, false), base)
  }

  /** Repository config a git or gh command may change for later commands, read without proof. */
  private noteChanges(name: string, args: Word[], result: RuleResult): void {
    if (result.kind === 'non-send' && result.changes === 'remotes') this.state.remotesChanged = true
    if (result.kind === 'non-send' && result.changes === 'branch') this.state.branchChanged = true
    // A rule's own answer is exact; only unmodeled commands are read by their words.
    if (result.kind !== 'unmodeled') return
    const words = new Set(args.filter(word => word.literal).map(word => word.text))
    if (name === 'git' && ['config', 'remote', 'clone', 'init'].some(word => words.has(word))) this.state.remotesChanged = true
    if (name === 'git' && ['checkout', 'switch', 'branch', 'worktree'].some(word => words.has(word))) this.state.branchChanged = true
    if (name === 'gh' && (words.has('set-default') || args[0]?.text === 'auth' || args[0]?.text === 'config')) this.state.remotesChanged = true
    // A command that names the repository's config file may rewrite it.
    if (this.cmd.searchText.includes('.git/config') || this.cmd.searchText.includes('gitconfig')) this.state.remotesChanged = true
  }

  /** Backstop candidates: each list entry the command and its pipeline name. */
  private backstop(extra: BackstopEntry[] = []): SendCandidate[] {
    const text = this.siblings.map(sibling => sibling.searchText).join('\n')
    const entries = new Set<BackstopEntry>([...backstopEntries(text), ...extra])
    const cwd = this.state.cwd.dir
    return [...entries].map(entry => unclassified(entry, this.cmd.text, cwd))
  }
}
