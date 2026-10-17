// What earlier segments of one Bash call leave behind for later ones
// (execution-safety-recovery D4, check 3 "proven context"): the effective
// directory and whether it is certain, the environment names the call
// assigned, the context failures (an unevaluated builtin, an assigning
// expansion), and whether the repository's remotes or branch changed. Only
// builtins the parser evaluates exactly move this state: `cd`, `pushd`, and
// `popd` with literal arguments, `export`, and assignments. A cd whose
// success is not implied by the `&&` chain to the candidate leaves the
// directory uncertain. Pure.
import path from 'node:path'
import type { FailureCode } from './proof'
import type { Word } from './tokenize'

export interface Cwd {
  dir: string
  certain: boolean
}

export interface CallState {
  cwd: Cwd
  stack: Cwd[]
  /** A cd ran: crossing any connector but `&&` makes the directory uncertain. */
  cdSeen: boolean
  assigned: Set<string>
  context: Set<FailureCode>
  remotesChanged: boolean
  branchChanged: boolean
  home?: string
}

export function initialState(cwd: string, home?: string): CallState {
  return {
    cwd: { dir: cwd, certain: true }, stack: [], cdSeen: false, assigned: new Set(), context: new Set(),
    remotesChanged: false, branchChanged: false, ...(home === undefined ? {} : { home }),
  }
}

/** A copy for a nested `bash -c` script: its shell state never leaks back. */
export function childState(state: CallState, cwd: Cwd, assigned: Iterable<string>): CallState {
  return {
    ...state, cwd, stack: [], cdSeen: false,
    assigned: new Set([...state.assigned, ...assigned]), context: new Set(state.context),
  }
}

/** Names whose value cannot change where a send goes or what runs. */
const HARMLESS_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|CI|NODE_ENV|GIT_AUTHOR_(NAME|EMAIL|DATE)|GIT_COMMITTER_(NAME|EMAIL|DATE)|GIT_TERMINAL_PROMPT|HUSKY|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GH_SPINNER_DISABLED|DEBIAN_FRONTEND|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE)$/

export const pinsEnvironment = (names: Iterable<string>): boolean => [...names].some(name => !HARMLESS_ENV.test(name))

/** Bash builtins: anything else is an external command that cannot change the shell. */
export const BUILTINS = new Set([
  'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'declare',
  'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help',
  'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray',
  'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset',
  'ulimit', 'umask', 'unalias', 'unset', 'wait', '.', ':', '[', '[[', ']]',
])
/** Builtins that change neither the directory, the environment, nor what a name runs. */
const HARMLESS = new Set([':', '[', '[[', 'test', 'echo', 'false', 'true', 'pwd', 'type', 'help', 'jobs', 'times', 'wait', 'kill', 'exit', 'return', 'break', 'continue', 'dirs', 'shift', 'umask', 'ulimit'])
/** `set` options that change no directory, environment, or command. */
const SET_OPTION = /^[-+]([euxvhBCHPT]+|o)$|^(pipefail|errexit|nounset|xtrace|verbose|noclobber)$/

/** Resolve a directory word against a base: an absolute path, `./x`, `../x`, or uncertain. */
export function resolveDir(base: Cwd, word: Word, cdpath: boolean): Cwd {
  if (!word.literal) return { dir: base.dir, certain: false }
  if (word.text.startsWith('/')) return { dir: path.posix.resolve(word.text), certain: true }
  // A bare relative name may resolve through CDPATH, which the parser never reads.
  const anchored = !cdpath || word.text === '.' || word.text === '..' || word.text.startsWith('./') || word.text.startsWith('../')
  return { dir: path.posix.resolve(base.dir, word.text), certain: base.certain && anchored }
}

/**
 * Evaluate one builtin run in the shell itself. `counts` says whether its
 * effect is sure to happen: its own pipeline is one command, nothing runs it
 * in the background, and no `||` makes it conditional. Returns null when
 * `name` is not a builtin, `exact` when its effect is modeled, and
 * `unevaluated` when it may do anything (`eval`, `source`, `trap`, …): the
 * caller hands that command to the backstop.
 */
export function evaluateBuiltin(state: CallState, name: string, args: Word[], counts: boolean): 'exact' | 'unevaluated' | null {
  if (!BUILTINS.has(name)) return null
  if (name === 'cd' || name === 'pushd' || name === 'popd') {
    changeDir(state, name, args, counts)
    return 'exact'
  }
  if (name === 'export') {
    for (const word of args) {
      const assigned = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|$)/.exec(word.text)
      if (assigned === null || word.text.startsWith('-')) state.context.add('unevaluated-builtin')
      else state.assigned.add(assigned[1]!)
    }
    return 'exact'
  }
  if (name === 'set' && args.every(word => word.literal && SET_OPTION.test(word.text))) return 'exact'
  if (name === 'printf' && !args.some(word => word.text.startsWith('-v'))) return 'exact'
  if (HARMLESS.has(name)) return 'exact'
  state.context.add('unevaluated-builtin')
  return 'unevaluated'
}

function changeDir(state: CallState, name: string, args: Word[], counts: boolean): void {
  state.cdSeen = true
  const operands = args.filter((word, index) => !(index === 0 && /^-[LPe@]+$/.test(word.text)) && word.text !== '--')
  const previous = state.cwd
  let next: Cwd
  if (name === 'popd') {
    next = operands.length === 0 ? state.stack.pop() ?? { dir: previous.dir, certain: false } : { dir: previous.dir, certain: false }
  } else if (operands.length === 0) {
    next = name === 'cd' && state.home !== undefined ? { dir: state.home, certain: true } : { dir: previous.dir, certain: false }
  } else if (operands.length > 1 || operands[0]!.text === '-' || /^[+-]\d/.test(operands[0]!.text)) {
    next = { dir: previous.dir, certain: false }
  } else {
    next = resolveDir(previous, operands[0]!, true)
    if (name === 'pushd') state.stack.push(previous)
  }
  state.cwd = counts ? next : { dir: next.dir, certain: false }
}
