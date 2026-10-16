// Unwrapping before rule matching (execution-safety-recovery D4): strip the
// shell reserved words and wrapping commands that only precede the command
// the rules mean, each wrapper flag consumed by its arity, and find where
// git's subcommand sits and what config pins its target. Split out of
// `rules.ts` when that file outgrew the 500-LOC rule; the rules table
// itself stays there. Pure, like the rest of the classifier.
import type { SendCandidate } from './classify'

/** Shell reserved words that only precede the command the rules mean. */
export const RESERVED = new Set(['!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time'])
/**
 * Wrappers that only carry the command, with the flags the classifier knows
 * the arity of. A flag outside both lists is not understood: the segment
 * records unknown-destination rather than a guessed position (CC M5).
 */
const WRAPPERS: Record<string, { booleans: string[]; values: string[]; skipDuration?: boolean }> = {
  sudo: {
    booleans: ['-E', '-e', '-i', '-k', '-K', '-l', '-n', '-S', '-s', '-v', '-H', '-P', '-V', '--'],
    values: ['-u', '-g', '-p', '-r', '-t', '-C', '--user', '--group', '--prompt', '--host', '--role', '--type', '--other-user', '--close-from', '--askpass'],
  },
  timeout: {
    booleans: ['--foreground', '--preserve-status', '-v', '-l', '--help', '--version'],
    values: ['-s', '-k', '--signal', '--kill-after'],
    skipDuration: true,
  },
  nice: { booleans: ['--'], values: ['-n', '--adjustment'] },
  xargs: {
    booleans: ['-r', '-t', '--no-run-if-empty', '--verbose', '--trace', '--exit', '--help', '--version'],
    values: ['-d', '-I', '-J', '-s', '-j', '-P', '-L', '-l', '-n', '-E', '-a', '-o', '--delimiter', '--arg-file', '--max-args', '--max-chars', '--max-procs', '--max-lines', '--replace', '--eof'],
  },
  command: { booleans: ['-p', '-v', '-V', '--'], values: [] },
  exec: { booleans: ['-l', '--'], values: ['-a'] },
  nohup: { booleans: ['--'], values: [] },
  stdbuf: { booleans: ['--'], values: ['-o', '-e', '-i', '--output', '--error', '--input'] },
  ionice: { booleans: ['-t', '--'], values: ['-c', '-n', '-p', '--class', '--classdata', '--pid'] },
  doas: { booleans: ['-n', '-s', '-v', '-V', '--'], values: ['-u', '-C', '-a'] },
}

/** What unwrapping left: the command, or why its position is unknowable. */
export interface Unwrapped {
  argv: string[]
  /** A wrapper flag the table does not know: the segment reads unknown. */
  unknown: string | null
}

/**
 * Drop the leading reserved words and wrapping commands (`sudo -u bob`,
 * `timeout -s KILL 5`, `nice -n 5`, `xargs`, `stdbuf -oL`, …), each flag
 * consumed by its arity. `timeout`'s duration positional is skipped too.
 */
export function unwrapWrappers(argv: string[]): Unwrapped {
  let rest = argv
  for (;;) {
    while (rest.length > 0 && RESERVED.has(rest[0]!.split('/').pop()!)) rest = rest.slice(1)
    const spec = rest[0] === undefined ? undefined : WRAPPERS[rest[0]!.split('/').pop()!]
    if (spec === undefined) return { argv: rest, unknown: null }
    let i = 1
    let unknown = false
    while (i < rest.length) {
      const word = rest[i]!
      if (word === '--') { i++; break }
      if (word === '-' || !word.startsWith('-')) break
      const eq = word.indexOf('=')
      if (word.startsWith('--')) {
        const name = eq === -1 ? word : word.slice(0, eq)
        if (spec.values.includes(name)) { if (eq === -1) i++; i++; continue }
        if (spec.booleans.includes(name)) { i++; continue }
        unknown = true
        break
      }
      // A short cluster walks letter by letter, exactly as `scan` does: the
      // first value letter takes the cluster's rest (or `=` value, or the
      // next word) as its value (`sudo -Eu x`, `stdbuf -oL`, `ionice -c3`).
      const letters = word.slice(1)
      const attached = eq === -1 ? null : word.slice(eq + 1)
      let valueTakesNext = false
      let understood = true
      for (let at = 0; at < letters.length; at++) {
        const letter = `-${letters[at]!}`
        if (spec.values.includes(letter)) {
          valueTakesNext = at === letters.length - 1 && attached === null
          break
        }
        if (!spec.booleans.includes(letter)) { understood = false; break }
      }
      if (!understood) { unknown = true; break }
      i++
      if (valueTakesNext) i++
      continue
    }
    if (unknown) return { argv: [], unknown: `the ${rest[0]!.split('/').pop()} options were not understood` }
    rest = rest.slice(i)
    if (spec.skipDuration === true && rest.length > 0 && /^[\d.]+(ms|[smhd])?$/.test(rest[0]!)) rest = rest.slice(1)
  }
}

/** The rule an unknown-wrapped segment most plausibly sends under. */
export const WRAPPED_RULE_HEADS: Record<string, SendCandidate['rule']> = {
  git: 'git-push', gh: 'gh-write', curl: 'http-send', wget: 'http-send',
  http: 'http-send', https: 'http-send', npm: 'registry-publish',
  pnpm: 'registry-publish', yarn: 'registry-publish', bun: 'registry-publish',
  cargo: 'registry-publish', twine: 'registry-publish', docker: 'registry-publish',
  podman: 'registry-publish', helm: 'registry-publish', buildctl: 'registry-publish',
  sendmail: 'mail-send', msmtp: 'mail-send', mailx: 'mail-send', ssmtp: 'mail-send', mail: 'mail-send',
}

/**
 * Where git's subcommand sits, and what pins its push target unresolved if
 * anything does: a `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG*` assignment,
 * a `--git-dir`/`--work-tree`/`--config-env` flag, or a `git -c` override
 * whose key starts `remote.`, `url.`, or `branch.` (git keys are
 * case-insensitive). The classifier does not evaluate shell variables.
 */
export function gitSubcommandAndPin(argv: readonly string[], env: ReadonlyMap<string, string | null>): { subcommandAt: number; pinned: string | null } {
  let subcommandAt = -1
  let pinned: string | null = null
  for (const key of env.keys()) {
    if (key === 'GIT_DIR') pinned = 'GIT_DIR is set'
    else if (key === 'GIT_WORK_TREE') pinned = 'GIT_WORK_TREE is set'
    else if (key.startsWith('GIT_CONFIG')) pinned = `${key} is set`
  }
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '-C' || word === '-c') {
      if (word === '-c') {
        const setting = argv[i + 1] ?? ''
        // git keys are case-insensitive: Remote., URL., Branch. alike.
        if (/^(remote|url|branch)\./i.test(setting)) pinned = 'a git -c override pins the target'
      }
      i++
      continue
    }
    if (word.startsWith('--git-dir') || word.startsWith('--work-tree') || word.startsWith('--namespace') || word.startsWith('--config-env')) {
      pinned = word.startsWith('--config-env') ? 'git --config-env pins the target' : 'git directory flags pin the target'
      if (!word.includes('=')) i++
      continue
    }
    if (word.startsWith('-')) continue
    subcommandAt = i
    break
  }
  return { subcommandAt, pinned }
}
