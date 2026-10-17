// Unwrapping before rule matching (execution-safety-recovery D4): leading
// `NAME=value` assignments and wrapping commands (`sudo -u bob`, `timeout -s
// KILL 5`, `nice -n 5`, `env -C dir NAME=v`, `xargs -t`, `stdbuf -oL`, …)
// drop off with their options, read by the shared scanner against each
// wrapper's arity table, and one `bash -c` / `sh -c` level yields its script.
// A wrapper option outside its table, `env -S`, or an option a wrapper reads
// files or shells through leaves the segment unmodeled — the backstop then
// searches it — never a guessed position. Pure.
import { scanOptions, table, type OptionTable } from './options'
import type { Word } from './tokenize'

export interface Wrapped {
  /** Environment names this segment sets for its command (prefix, `env NAME=v`). */
  assigned: Set<string>
  /** `env -i`: the inherited and earlier environment is dropped. */
  cleared: boolean
  /** Names `env -u` removed for the command. */
  unset: string[]
  /** Directory changes (`env -C`, `sudo -D`), applied in order. */
  chdir: Word[]
  /** The wrappers that ran, outermost first (basenames). */
  wrappers: string[]
}

export type Unwrapped =
  | ({ kind: 'command'; head: Word; args: Word[] } & Wrapped)
  | ({ kind: 'shell'; shell: string; script: Word } & Wrapped)
  /** Only assignments: they persist in the calling shell. */
  | ({ kind: 'assignments' } & Wrapped)
  /** A wrapper that runs nothing (`env` alone, `command -v x`): a read. */
  | ({ kind: 'query' } & Wrapped)
  | { kind: 'unmodeled' }

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/

/** Wrapper option tables; an option outside them leaves the segment unmodeled. */
const WRAPPERS: Record<string, OptionTable> = {
  sudo: table(
    '-A -b -E -H -k -n -P -S --askpass --background --preserve-groups --non-interactive --set-home --stdin',
    '-u -g -p -r -t -C -U -h -T -D --user --group --prompt --role --type --other-user --close-from --host --command-timeout --chdir',
    '--preserve-env',
  ),
  doas: table('-n', '-u -a'),
  timeout: table('-v --verbose --foreground --preserve-status', '-s -k --signal --kill-after'),
  nice: table('', '-n --adjustment'),
  nohup: table(''),
  stdbuf: table('', '-i -o -e --input --output --error'),
  ionice: table('-t --ignore', '-c -n -p -P -u --class --classdata --pid --pgid --uid'),
  command: table('-p -v -V'),
  exec: table('-c -l', '-a'),
  builtin: table(''),
  xargs: table(
    '-0 -r -t -x --null --no-run-if-empty --verbose --exit',
    '-a -d -E -I -L -n -P -s --arg-file --delimiter --max-args --max-procs --max-chars --process-slot-var',
    '-e -i -l --eof --replace --max-lines',
  ),
}
const ENV = table(
  '-i -0 -v --ignore-environment --null --debug --list-signal-handling',
  '-u -C --unset --chdir',
  '--default-signal --ignore-signal --block-signal',
)
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** Shell option letters that are plain flags; `o`/`O` take a name; `c` names the script. */
const SHELL_FLAGS = new Set('abefhiklmnprstuvxBCDEHILMPRSTUVWX'.split(''))
const SHELL_LONG = new Set(['--noprofile', '--norc', '--posix', '--restricted', '--login', '--noediting', '--verbose', '--debugger'])
const SHELL_LONG_VALUES = new Set(['--rcfile', '--init-file'])

export const basename = (text: string): string => text.split('/').pop() ?? text

/** Unwrap one simple command's words (reserved words already stripped). */
export function unwrap(words: readonly Word[]): Unwrapped {
  const wrapped: Wrapped = { assigned: new Set(), cleared: false, unset: [], chdir: [], wrappers: [] }
  let at = 0
  for (;;) {
    while (at < words.length && ASSIGNMENT.test(words[at]!.text)) {
      wrapped.assigned.add(ASSIGNMENT.exec(words[at]!.text)![1]!)
      at++
    }
    if (at >= words.length) return { kind: wrapped.wrappers.length === 0 ? 'assignments' : 'query', ...wrapped }
    const head = words[at]!
    if (!head.literal) return { kind: 'command', head, args: words.slice(at + 1), ...wrapped }
    const name = basename(head.text)
    if (name === 'env') {
      const scanned = scanOptions(words, at + 1, ENV, true)
      if (scanned.unknown !== null) return { kind: 'unmodeled' }
      for (const option of scanned.options) {
        if (option.name === '-i' || option.name === '--ignore-environment') { wrapped.cleared = true; wrapped.assigned.clear() }
        if (option.name === '-u' || option.name === '--unset') {
          if (option.value === null) return { kind: 'unmodeled' }
          wrapped.unset.push(option.value.text)
          wrapped.assigned.delete(option.value.text)
        }
        if (option.name === '-C' || option.name === '--chdir') {
          if (option.value === null) return { kind: 'unmodeled' }
          wrapped.chdir.push(option.value)
        }
      }
      at = scanned.end
      // A lone `-` means -i.
      if (words[at]?.text === '-') { wrapped.cleared = true; wrapped.assigned.clear(); at++ }
      wrapped.wrappers.push(name)
      continue
    }
    const options = WRAPPERS[name]
    if (options !== undefined) {
      const scanned = scanOptions(words, at + 1, options, true)
      if (scanned.unknown !== null) return { kind: 'unmodeled' }
      if (name === 'command' && scanned.options.some(option => option.name === '-v' || option.name === '-V')) {
        return { kind: 'query', ...wrapped }
      }
      for (const option of scanned.options) {
        if (option.name === '-D' || option.name === '--chdir') {
          if (option.value === null) return { kind: 'unmodeled' }
          wrapped.chdir.push(option.value)
        }
      }
      at = scanned.end
      if (name === 'timeout') {
        // The duration is timeout's own positional.
        const duration = words[at]
        if (duration === undefined || !duration.literal || !/^[\d.]+[smhd]?$/.test(duration.text)) return { kind: 'unmodeled' }
        at++
      }
      wrapped.wrappers.push(name)
      continue
    }
    if (SHELLS.has(name)) return unwrapShell(words, at, name, wrapped)
    return { kind: 'command', head, args: words.slice(at + 1), ...wrapped }
  }
}

/** `bash [options] -c 'script' [args…]` yields its script; any other shell call is a command. */
function unwrapShell(words: readonly Word[], at: number, shell: string, wrapped: Wrapped): Unwrapped {
  let i = at + 1
  let hasC = false
  while (i < words.length) {
    const word = words[i]!
    const text = word.text
    // After `-c`, the first operand is the script, literal or not.
    if (!word.literal) {
      if (hasC) break
      return { kind: 'unmodeled' }
    }
    if (text === '--' || text === '-') { i++; break }
    if (SHELL_LONG.has(text)) { i++; continue }
    if (SHELL_LONG_VALUES.has(text)) { i += 2; continue }
    if (/^[-+][oO]$/.test(text)) { i += 2; continue }
    if (/^[-+][A-Za-z]+$/.test(text)) {
      for (const letter of text.slice(1)) {
        if (letter === 'c' && text.startsWith('-')) hasC = true
        else if (!SHELL_FLAGS.has(letter)) return { kind: 'unmodeled' }
      }
      i++
      continue
    }
    if (text.startsWith('-') || text.startsWith('+')) return { kind: 'unmodeled' }
    break
  }
  if (!hasC) return { kind: 'command', head: words[at]!, args: words.slice(at + 1), ...wrapped }
  const script = words[i]
  if (script === undefined) return { kind: 'unmodeled' }
  return { kind: 'shell', shell, script, ...wrapped, wrappers: [...wrapped.wrappers, shell] }
}
