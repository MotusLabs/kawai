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

export interface Token {
  kind: 'word' | 'op'
  text: string
  /** Where the token sits in the source: its span keeps quotes intact (D4). */
  start: number
  end: number
  /** A word holding unexpanded shell text (`$VAR`, `$(…)`, backticks). */
  opaque?: boolean
}

/** Tokenize one command string; operators stand alone, quoting is unwound. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let opaque = false
  let atWordStart = true
  let wordStart = -1
  const flush = () => {
    if (word !== '' || opaque) {
      tokens.push({ kind: 'word', text: word, start: wordStart === -1 ? i : wordStart, end: i, ...(opaque ? { opaque: true } : {}) })
    }
    word = ''
    opaque = false
    atWordStart = true
    wordStart = -1
  }
  const pushOp = (text: string) => {
    const opStart = i
    flush()
    tokens.push({ kind: 'op', text, start: opStart, end: opStart + text.length })
  }
  let i = 0
  while (i < input.length) {
    const char = input[i]!
    // A word starts here: its span keeps the quotes it opens (D4).
    if (wordStart === -1 && word === '' && !/\s/.test(char)) wordStart = i
    if (char === "'") {
      // Literal until the closing quote; a word made only of it stays one.
      const end = input.indexOf("'", i + 1)
      if (end === -1) { word += input.slice(i + 1); i = input.length } else { word += input.slice(i + 1, end); i = end + 1 }
      atWordStart = false
      continue
    }
    if (char === '"') {
      atWordStart = false
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\' || input[i + 1] === '$')) {
          word += input[i + 1]!
          i += 2
          continue
        }
        const expansion = readExpansion(input, i)
        if (expansion) {
          word += expansion.text
          opaque = true
          i = expansion.next
          continue
        }
        word += input[i]!
        i++
      }
      i++ // the closing quote
      continue
    }
    if (char === '\\') {
      // Outside quotes a backslash escapes anything, including newlines.
      if (input[i + 1] !== undefined) { word += input[i + 1]!; i += 2; atWordStart = false; continue }
      i++
      continue
    }
    if (char === '$' || char === '`') {
      const expansion = readExpansion(input, i)
      if (expansion) { word += expansion.text; opaque = true; i = expansion.next; atWordStart = false; continue }
    }
    if (/\s/.test(char)) {
      if (char === '\n') pushOp('\n')
      else flush()
      i++
      continue
    }
    if (char === '#' && atWordStart) {
      // A comment runs to the end of the line.
      const end = input.indexOf('\n', i)
      i = end === -1 ? input.length : end
      continue
    }
    if (char === ';' || char === '|' || char === '&') {
      const two = input.slice(i, i + 2)
      if (two === '&&' || two === '||') { pushOp(two); i += 2; continue }
      pushOp(char)
      i++
      continue
    }
    // Grouping brackets split only where the shell reads them: `(` opens at a
    // word start, `)` closes at a word end, and `{`/`}` stand alone — so
    // `repos/{owner}/{repo}` keeps its braces inside the word.
    const boundary = (text: string, at: number) => text[at] === undefined || /[\s;|&(){}]/.test(text[at]!)
    if (char === '(' && atWordStart) { pushOp(char); i++; continue }
    if (char === ')' && boundary(input, i + 1)) { pushOp(char); i++; continue }
    if ((char === '{' || char === '}') && atWordStart && boundary(input, i + 1)) { pushOp(char); i++; continue }
    if (char === '<' || char === '>') {
      // A redirect is one word: an fd prefix, the arrows, maybe `&fd`, maybe
      // an attached target. `2>&1` stands alone; `>/dev/null` carries its
      // target; `<<EOF` yields the arrows and the attached delimiter word.
      const fd = /^\d+$/.test(word) ? word : ''
      if (fd === '') flush()
      else word = ''
      wordStart = i
      let blob = fd + char
      i++
      if ((char === '<' || char === '>') && (input[i] === '<' || input[i] === '>' || input[i] === '&')) {
        blob += input[i]!
        i++
        if (blob.endsWith('&')) {
          while (/[0-9]/.test(input[i] ?? '')) { blob += input[i]!; i++ }
        }
      }
      if (blob.endsWith('<<')) {
        if (input[i] === '-') { blob += '-'; i++ }
        flush()
        tokens.push({ kind: 'word', text: blob, start: wordStart === -1 ? i : wordStart, end: i })
        let delimiter = ''
        const delimiterStart = i
        while (i < input.length && !/[\s;|&<>"']/.test(input[i]!)) { delimiter += input[i]!; i++ }
        if (delimiter !== '') tokens.push({ kind: 'word', text: delimiter, start: delimiterStart, end: i })
        atWordStart = false
        continue
      }
      while (i < input.length && !/[\s;|&<>"']/.test(input[i]!)) { blob += input[i]!; i++ }
      word = blob
      opaque = false
      atWordStart = false
      continue
    }
    // Any other character joins the current word.
    word += char
    atWordStart = false
    i++
  }
  flush()
  return tokens
}

/** An unexpanded region starting at `i` (`$(`…`)`, `${`…`}`, `$name`, backticks); its text kept verbatim. */
function readExpansion(input: string, i: number): { text: string; next: number } | null {
  const char = input[i]!
  if (char !== '$' && char !== '`') return null
  if (char === '`') {
    const end = input.indexOf('`', i + 1)
    if (end === -1) return { text: input.slice(i), next: input.length }
    return { text: input.slice(i, end + 1), next: end + 1 }
  }
  if (input[i + 1] === '(') {
    let depth = 0
    for (let j = i + 1; j < input.length; j++) {
      if (input[j] === '(') depth++
      else if (input[j] === ')' && --depth === 0) return { text: input.slice(i, j + 1), next: j + 1 }
    }
    return { text: input.slice(i), next: input.length }
  }
  if (input[i + 1] === '{') {
    const end = input.indexOf('}', i + 2)
    if (end === -1) return { text: input.slice(i), next: input.length }
    return { text: input.slice(i, end + 1), next: end + 1 }
  }
  const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(i + 1))
  if (name) return { text: input.slice(i, i + 1 + name[0].length), next: i + 1 + name[0].length }
  return null
}

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
const REDIRECT_ALONE = /^(?:\d*(?:>>?|<>)&\d*|>&\d+)$/
const HEREDOC = /^<<-?$/

/** A directory a segment can pin, or null when the shell would expand it (`~`). */
function resolveDir(dir: string, cwd: string): string | null {
  if (dir === '~' || dir.startsWith('~/')) return null
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
    if (rest[0]!.text === 'env') {
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
        if (word.text === '-C' && rest[at + 1] !== undefined) {
          const dir = resolveDir(rest[at + 1]!.text, segmentCwd)
          if (dir !== null) segmentCwd = dir
          at += 2
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
    const flagIsC = /^-[a-qs-z]*c[a-qs-z]*$|^-[a-z]*c[a-z]*$/.test(rest[1]?.text ?? '')
    if (SHELLS.has(rest[0]!.text) && (rest[1]?.text === '-c' || flagIsC) && rest[2] !== undefined) {
      if (depth > 0) { note = 'a second -c level is never unwrapped'; break }
      if (!rest[2]!.opaque) {
        const inner = parseSegments(rest[2]!.text, segmentCwd, env, depth + 1)
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
  if (argv[0] === 'git') {
    const dashC = argv.findIndex((word, index) => index > 0 && (word === '-C') && argv.length > index + 1)
    const pinned = dashC > 0 ? resolveDir(argv[dashC + 1]!, cwd) : null
    if (pinned !== null) segmentCwd = pinned
  }
  // `cd <dir>` moves every later segment.
  let chdir: string | undefined
  if (argv[0] === 'cd' && argv[1] !== undefined && !argv[1]!.startsWith('-') && !rest[1]!.opaque) {
    const target = resolveDir(argv[1]!, cwd)
    if (target !== null) chdir = target
  }
  return {
    segments: [{ argv, text: span === null ? argv.join(' ') : span.command.slice(span.start, span.end), cwd: segmentCwd, env, ...(note === undefined ? {} : { note }) }],
    envUpdates,
    envDeletes,
    ...(chdir === undefined ? {} : { chdir }),
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
export function parseCommand(command: string, initialCwd: string): CommandSegment[] {
  return parseSegments(command, initialCwd, new Map(), 0)
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
  const finish = () => {
    const built = buildSegment(words, runningEnv, cwd, depth, span)
    words = []
    span = null
    for (const name of built.envDeletes) runningEnv.delete(name)
    for (const [name, value] of built.envUpdates) runningEnv.set(name, value)
    if (built.chdir !== undefined) cwd = built.chdir
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
