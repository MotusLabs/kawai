// Command parsing for the outbound classifier (execution-safety-recovery
// D4): tokenize with shell quoting rules (single and double quotes,
// backslash escapes, `$(…)` and backticks kept as opaque words), split into
// segments on `;`, `&&`, `||`, `|`, `&`, and newlines, unwrap one level of
// `bash -c` / `sh -c` / `env … cmd`, and track `cd <dir>` and `git -C <dir>`
// so every segment carries its effective cwd. Heredoc bodies are consumed,
// never segments. Pure: no I/O, and unexpanded shell text — variables,
// command substitution — stays opaque for the classifier to read as
// unresolved. Redirects are dropped from argv; rule matching reads argument
// positions and flags, never raw text.
import { RESERVED, unwrapWrappers } from './unwrapping'
import { tokenize } from './tokenize'


/** One command between shell operators, ready for rule matching. */
export interface CommandSegment {
  /** The command words after one-level unwrap and redirect removal. */
  argv: string[]
  /**
   * The segment's original source span, quotes and whitespace intact — the
   * audit record stores this (D8: redaction sees the quoting), never
   * rejoined words.
   */
  text: string
  /** The effective cwd: the initial one, moved by `cd`, pinned by `git -C`. */
  cwd: string
  /** Literal environment assignments in effect (`NAME` → value; null = set to unexpanded text). */
  env: ReadonlyMap<string, string | null>
  /** Why this segment's positions cannot be trusted (D4): an unknown wrapper
   *  flag, a second `-c` level, an unreadable `env` option. */
  note?: string
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
/** Shell options the parser knows as booleans (round 6 B5). */
const SHELL_FLAG_LETTERS = /^[abcefhiklmnprstuvxBCDEHILMPRSTUVWX]*$/
const SHELL_LONG_FLAGS = new Set(['--noprofile', '--norc', '--posix', '--restricted', '--login', '--interactive', '--help', '--version', '--'])
const REDIRECT_ALONE = /^(?:\d*(?:>>?|<>)&\d*|>&\d+)$/
const HEREDOC = /^<<-?$/

/** Why a directory change cannot be resolved (I1: never silently kept). */
export const CWD_UNRESOLVED = 'the working directory does not resolve'

/** A directory a segment can pin, or null when the shell would expand it. */
function resolveDir(dir: string, cwd: string): string | null {
  // ~, ~user, and `cd -` all depend on state or names the parser never sees.
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~') || dir === '-') return null
  if (dir.startsWith('/')) return dir
  return cwd.replace(/\/$/, '') + '/' + dir
}

/** Drop redirect words (and their targets) from raw segment words. */
function withoutRedirects(words: Array<{ text: string; opaque: boolean }>): Array<{ text: string; opaque: boolean }> {
  const kept: typeof words = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (HEREDOC.test(word.text)) continue
    if (REDIRECT_ALONE.test(word.text)) continue
    if (/^(?:\d*)>>?$|^(?:\d*)<$|^<>$|^&>>$/.test(word.text)) {
      i++ // the redirect target is never a command word
      continue
    }
    kept.push(word)
  }
  return kept
}

interface Built {
  segments: CommandSegment[]
  /** Persistent environment changes an assignment-only or `export` segment makes. */
  envUpdates: Map<string, string | null>
  /** Names an `env -u` segment removed for its own command. */
  envDeletes: string[]
  /** A persistent cwd change (`cd`); a subshell never moves the parent. */
  chdir?: string
  /** The cwd stopped resolving (`cd ~`, `cd -`, popd): later sends read unresolved. */
  chdirStuck?: boolean
}

/** The segment's original source span, when the words carry one. */
interface SourceSpan {
  command: string
  start: number
  end: number
}

/** Build one segment (or a subshell's segments) from its raw words. */
function buildSegment(
  words: Array<{ text: string; opaque: boolean }>,
  runningEnv: ReadonlyMap<string, string | null>,
  cwd: string,
  depth: number,
  span: SourceSpan | null
): Built {
  const cleaned = withoutRedirects(words)
  const env = new Map(runningEnv)
  const envUpdates = new Map<string, string | null>()
  const envDeletes: string[] = []
  let rest = cleaned
  let segmentCwd = cwd
  let note: string | undefined
  // Leading `NAME=value` words prefix their command alone; assignment-only
  // segments (no command left) persist, exactly as the shell runs them.
  let assignmentsOnly = true
  for (;;) {
    while (rest.length > 0 && RESERVED.has(rest[0]!.text)) rest = rest.slice(1)
    if (rest.length === 0) break
    // Leading `NAME=value` words prefix whatever follows — a wrapper, a
    // shell, or the command — so they strip inside the loop (round 5 R1).
    while (rest.length > 0 && ASSIGNMENT.test(rest[0]!.text)) {
      const [, name, value] = ASSIGNMENT.exec(rest[0]!.text)!
      env.set(name, rest[0]!.opaque ? null : value)
      rest = rest.slice(1)
    }
    if (rest.length === 0) {
      // An assignment-only segment persists, exactly as the shell runs it.
      for (const word of cleaned) {
        if (ASSIGNMENT.test(word.text)) {
          const [, name, value] = ASSIGNMENT.exec(word.text)!
          envUpdates.set(name, word.opaque ? null : value)
        }
      }
      break
    }
    assignmentsOnly = false
    // A wrapping command (`sudo -u bob`, `timeout 5`, …) drops off with its
    // options; a flag the arity table does not know leaves the whole segment
    // unreadable, never a guessed position.
    const wrapper = unwrapWrappers(rest.map(word => word.text))
    if (wrapper.unknown !== null) { note = wrapper.unknown; break }
    if (wrapper.argv.length < rest.length) {
      rest = rest.slice(rest.length - wrapper.argv.length)
      continue
    }
    // `env [-C dir] [-i] [-u NAME] [NAME=value…] cmd…` unwraps one level.
    if (rest[0]!.text.split('/').pop() === 'env') {
      let at = 1
      let cleared = false
      let envUnreadable = false
      while (at < rest.length) {
        const word = rest[at]!
        if (word.text === '--') { at++; break }
        if (!word.opaque && ASSIGNMENT.test(word.text)) {
          const [, name, value] = ASSIGNMENT.exec(word.text)!
          env.set(name, value)
          at++
          continue
        }
        if (word.text.startsWith('-C') || word.text === '--chdir') {
          const attached = word.text.length > 2 ? { text: word.text.slice(2), opaque: word.opaque } : null
          const target = attached ?? rest[at + 1]
          if (target === undefined || target.opaque || (attached === null && at + 1 >= rest.length)) {
            note = CWD_UNRESOLVED
            at += attached === null ? 2 : 1
            break
          }
          const dir = resolveDir(target.text, segmentCwd)
          if (dir === null) {
            note = CWD_UNRESOLVED
            at += attached === null ? 2 : 1
            break
          }
          segmentCwd = dir
          at += attached === null ? 2 : 1
          continue
        }
        if (word.text === '-i' || word.text === '--ignore-environment') { cleared = true; at++; continue }
        if (word.text === '-u' || word.text === '--unset') {
          if (rest[at + 1] !== undefined) { env.delete(rest[at + 1]!.text); envDeletes.push(rest[at + 1]!.text) }
          at += 2
          continue
        }
        if (word.text.startsWith('-') && word.text !== '-') {
          // `-S` splits strings; anything else unknown: unreadable.
          envUnreadable = true
        }
        break
      }
      if (envUnreadable) { note = 'the env options were not understood'; break }
      if (cleared) for (const key of env.keys()) if (!envUpdates.has(key)) env.delete(key)
      rest = rest.slice(at)
      continue
    }
    // `bash -c 'inner'` unwraps exactly one level; a deeper level is noted.
    // Flags may precede -c (`sh -x -c …`), `--` may follow it, and an
    // absolute path names the same shell (round 5 R7).
    if (SHELLS.has(rest[0]!.text.split('/').pop()!)) {
      let at = 1
      let hasC = false
      let shellNote: string | undefined
      while (at < rest.length && /^[-+]/.test(rest[at]!.text) && rest[at]!.text !== '--' && rest[at]!.text !== '-') {
        const flag = rest[at]!.text
        if (/^-[a-qs-z]*c[a-qs-z]*$|^-[a-z]*c[a-z]*$/.test(flag)) { hasC = true; break }
        // -o/+o and -O/+O take an argument; any other option letter or an
        // unknown long flag leaves the shell call unresolved (round 6 B5).
        if (/^[-+]o$/.test(flag) || /^[-+]O$/.test(flag)) { at += 2; continue }
        if (flag.startsWith('--')) {
          if (!SHELL_LONG_FLAGS.has(flag)) shellNote = 'the shell options were not understood'
          at++
          continue
        }
        if (!SHELL_FLAG_LETTERS.test(flag.slice(1))) shellNote = 'the shell options were not understood'
        at++
      }
      if (shellNote !== undefined) { note = shellNote; break }
      if (hasC) {
        let innerAt = at + 1
        if (rest[innerAt]?.text === '--') innerAt++
        const innerWord = rest[innerAt]
        if (innerWord === undefined) { note = 'the -c string is missing'; break }
        if (depth > 0) { note = 'a second -c level is never unwrapped'; break }
        if (innerWord.opaque) { note = 'the -c string is a variable or command substitution'; break }
        const inner = parseSegments(innerWord.text, segmentCwd, env, depth + 1)
        return {
          segments: inner.map(segment => ({ ...segment, env: mergeEnv(env, segment.env) })),
          envUpdates: new Map(),
          envDeletes: [],
        }
      }
    }
    break
  }
  // `export NAME=value…` persists; neither is a command.
  if (rest[0]?.text === 'export' || assignmentsOnly && rest.length === 0) {
    if (rest[0]?.text === 'export') {
      for (const word of rest.slice(1)) {
        if (!word.opaque && ASSIGNMENT.test(word.text)) {
          const [, name, value] = ASSIGNMENT.exec(word.text)!
          envUpdates.set(name, value)
        }
      }
    }
    return { segments: [], envUpdates, envDeletes }
  }
  const argv = rest.map(word => word.text)
  // `git -C <dir>` pins this segment alone.
  let gitCwdNote: string | undefined
  if (argv[0]?.split('/').pop() === 'git') {
    // Every -C applies in order (git chdirs through them all): any opaque or
    // unresolvable one pins the whole chain; else the last directory wins.
    let pinnedDir: string | null = null
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!
      if (word === '--') break
      const attached = word.startsWith('-C') && word.length > 2
      if (word !== '-C' && !attached) {
        if (word.startsWith('-') && !word.startsWith('--')) continue
        if (word.startsWith('--') && word !== '--git-dir' && word !== '--work-tree' && word !== '--namespace' && word !== '--config-env') continue
        break
      }
      const target = attached ? word.slice(2) : argv[i + 1]
      if (target === undefined || (attached ? rest[i]!.opaque : rest[i + 1]?.opaque === true)) { gitCwdNote = CWD_UNRESOLVED; continue }
      const dir = resolveDir(target, cwd)
      if (dir === null) { gitCwdNote = CWD_UNRESOLVED; continue }
      pinnedDir = dir
      if (!attached) i++
    }
    if (gitCwdNote === undefined && pinnedDir !== null) segmentCwd = pinnedDir
  }
  // cd/pushd move every later segment; popd returns to a dir the parser
  // never tracked. An unresolvable target sticks the whole rest of the call
  // unresolved (round 6 B1).
  let chdir: string | undefined
  let chdirStuck = false
  if (argv[0] === 'pushd' && (argv[1] === '-n' || argv[1] === '--no-cd')) {
    // pushd -n only manipulates the stack: the cwd never moves.
  } else if (argv[0] === 'cd' || argv[0] === 'pushd') {
    const target = rest[1]
    if (argv[0] === 'cd' && target === undefined) chdirStuck = true
    else if (target === undefined || target.opaque || target.text.startsWith('-')) chdirStuck = argv[0] === 'cd' ? true : target?.text === '-' ? true : false
    if (target !== undefined && !target.opaque) {
      const dir = resolveDir(target.text, cwd)
      if (dir === null) chdirStuck = true
      else if (argv[0] === 'pushd' && target.text === '-') chdirStuck = true
      else chdir = dir
    }
  }
  if (argv[0] === 'popd') chdirStuck = true
  const segmentNote = note ?? gitCwdNote
  return {
    segments: [{ argv, text: span === null ? argv.join(' ') : span.command.slice(span.start, span.end), cwd: segmentCwd, env, ...(segmentNote === undefined ? {} : { note: segmentNote }) }],
    envUpdates,
    envDeletes,
    ...(chdir === undefined ? {} : { chdir }),
    ...(chdirStuck ? { chdirStuck: true } : {}),
  }
}

function mergeEnv(base: ReadonlyMap<string, string | null>, overlay: ReadonlyMap<string, string | null>): Map<string, string | null> {
  return new Map([...base, ...overlay])
}

/**
 * Split a command into segments: operators and heredoc bodies dropped, `cd`
 * tracked across segments, `git -C` pinning its own, one level of `env …` and
 * `bash -c` unwrapped, and each segment carrying the literal assignments that
 * precede it or that an earlier assignment or `export` segment set.
 */
/**
 * A backslash-newline continuation joins the lines, except inside single
 * quotes where both characters are literal (round 5 R2): `git \⏎push …`
 * tokenizes as one `git push` segment.
 */
function joinContinuations(command: string): string {
  let quoted = false
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quoted) {
      out += char
      if (char === "'") quoted = false
      continue
    }
    if (char === '\\') {
      if (command[i + 1] === '\n') { i++; continue }
      if (command[i + 1] !== undefined) { out += char + command[i + 1]!; i++; continue }
      out += char
      continue
    }
    if (char === "'") quoted = true
    out += char
  }
  return out
}

export function parseCommand(command: string, initialCwd: string): CommandSegment[] {
  return parseSegments(joinContinuations(command), initialCwd, new Map(), 0)
}

function parseSegments(
  command: string,
  initialCwd: string,
  baseEnv: ReadonlyMap<string, string | null>,
  depth: number
): CommandSegment[] {
  const tokens = tokenize(command)
  const segments: CommandSegment[] = []
  const runningEnv = new Map(baseEnv)
  let cwd = initialCwd
  let words: Array<{ text: string; opaque: boolean }> = []
  let expectDelimiter = false
  let heredocDelimiter: string | null = null
  let pendingBody = false
  let delimiter = ''
  const cwdStack: string[] = []
  let span: SourceSpan | null = null
  let cwdStuck = false
  const finish = () => {
    const built = buildSegment(words, runningEnv, cwd, depth, span)
    words = []
    span = null
    for (const name of built.envDeletes) runningEnv.delete(name)
    for (const [name, value] of built.envUpdates) runningEnv.set(name, value)
    if (built.chdir !== undefined) cwd = built.chdir
    if (built.chdirStuck === true) cwdStuck = true
    if (cwdStuck) {
      for (const segment of built.segments) {
        if (segment.note === undefined) segment.note = CWD_UNRESOLVED
      }
    }
    segments.push(...built.segments)
  }
  for (const token of tokens) {
    if (heredocDelimiter !== null) {
      if (token.kind === 'word' && token.text === heredocDelimiter) heredocDelimiter = null
      continue
    }
    if (token.kind === 'op') {
      finish()
      span = null
      // A heredoc body starts at the newline that ends its command line.
      if (token.text === '\n' && pendingBody) {
        heredocDelimiter = delimiter
        pendingBody = false
      }
      // A subshell or brace group keeps its own cwd; the parent's returns.
      if (token.text === '(' || token.text === '{') cwdStack.push(cwd)
      if ((token.text === ')' || token.text === '}') && cwdStack.length > 0) cwd = cwdStack.pop()!
      continue
    }
    if (expectDelimiter) {
      delimiter = token.text
      expectDelimiter = false
      pendingBody = true
      continue
    }
    if (token.text === '<<' || token.text === '<<-') {
      expectDelimiter = true
      continue
    }
    words.push({ text: token.text, opaque: token.opaque ?? false })
    // The segment's span grows to cover every word token, in source order.
    span = span === null
      ? { command, start: token.start, end: token.end }
      : { command, start: Math.min(span.start, token.start), end: Math.max(span.end, token.end) }
  }
  finish()
  return segments
}
