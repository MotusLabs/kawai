// The shell lexer for the outbound classifier (execution-safety-recovery D4,
// task revision 3): words, operators, and redirections, each with its source
// span. Every word records whether it is literal after quote removal — the
// first of the four checks `allowed` needs. A word is not literal when it
// holds any parameter, arithmetic, or command expansion (`$…`, `${…}`,
// `$(…)`, backticks), process substitution, an unquoted glob or brace
// expansion, an ANSI-C `$'…'` or locale `$"…"` string, a tilde other than a
// leading `~` or `~/` (which reads as the server's home directory when one
// is given), a mid-word parenthesis, or an unterminated quote. Heredoc
// bodies are read as raw lines at the newline that ends their command and
// count as literal only when their delimiter is quoted. Pure, and linear in
// the input: every scan moves forward and never re-reads text.
export interface Word {
  /** The word after quote removal; unexpanded parts are kept as written. */
  text: string
  literal: boolean
  start: number
  end: number
}

export interface Heredoc {
  /** The delimiter was quoted: the body is literal text. */
  quoted: boolean
  body: string
}

export type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; text: string; start: number; end: number }
  | { kind: 'redirect'; op: string; start: number; end: number; target: Word | null; heredoc?: Heredoc }

export interface LexOptions {
  /** The server's home directory: a leading `~` or `~/` reads as it. */
  home?: string
}

const SPACE = new Set([' ', '\t', '\r'])
/** Characters that end an unquoted word. */
const BREAK = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '<', '>'])

/** Tokenize one command string. */
export function tokenize(input: string, options: LexOptions = {}): Token[] {
  const tokens: Token[] = []
  const pending: Array<{ token: Extract<Token, { kind: 'redirect' }>; delimiter: string; stripTabs: boolean; quoted: boolean }> = []
  let i = 0
  const n = input.length
  const op = (text: string) => {
    tokens.push({ kind: 'op', text, start: i, end: i + text.length })
    i += text.length
  }
  while (i < n) {
    const c = input[i]!
    if (SPACE.has(c)) { i++; continue }
    if (c === '\\' && input[i + 1] === '\n') { i += 2; continue }
    if (c === '\n') {
      op('\n')
      // Heredoc bodies start on the line after the command that opened them.
      for (const doc of pending.splice(0)) i = readHeredocBody(input, i, doc)
      continue
    }
    if (c === '#') {
      const end = input.indexOf('\n', i)
      i = end === -1 ? n : end
      continue
    }
    if (c === ';') { op(input.startsWith(';;&', i) ? ';;&' : input.startsWith(';;', i) ? ';;' : input.startsWith(';&', i) ? ';&' : ';'); continue }
    if (c === '|') { op(input.startsWith('||', i) ? '||' : input.startsWith('|&', i) ? '|&' : '|'); continue }
    if (c === '&') {
      if (input.startsWith('&&', i)) { op('&&'); continue }
      if (input[i + 1] === '>') { i = readRedirect(input, i, '', tokens, pending, options); continue }
      op('&')
      continue
    }
    if (c === '(' || c === ')') { op(c); continue }
    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      // Process substitution: a command runs; the word is never literal.
      const end = balancedEnd(input, i + 1)
      tokens.push({ kind: 'word', word: { text: input.slice(i, end), literal: false, start: i, end } })
      i = end
      continue
    }
    if (c === '<' || c === '>') { i = readRedirect(input, i, '', tokens, pending, options); continue }
    const fd = /^\d+(?=[<>])/.exec(input.slice(i, i + 12))
    if (fd !== null) { i = readRedirect(input, i + fd[0].length, fd[0], tokens, pending, options, i); continue }
    if ((c === '{' || c === '}') && (i + 1 >= n || BREAK.has(input[i + 1]!) || input[i + 1] === ')')) { op(c); continue }
    const read = readWord(input, i, options)
    tokens.push({ kind: 'word', word: read })
    i = read.end
  }
  return tokens
}

/** Read one redirection (`>`, `>>`, `<`, `<>`, `>|`, `<&`, `>&`, `&>`, `&>>`, `<<`, `<<-`, `<<<`) and its target. */
function readRedirect(
  input: string,
  at: number,
  fd: string,
  tokens: Token[],
  pending: Array<{ token: Extract<Token, { kind: 'redirect' }>; delimiter: string; stripTabs: boolean; quoted: boolean }>,
  options: LexOptions,
  start = at,
): number {
  const forms = ['<<<', '<<-', '&>>', '<<', '>>', '<>', '>|', '<&', '>&', '&>', '<', '>']
  const form = forms.find(candidate => input.startsWith(candidate, at))!
  let i = at + form.length
  while (i < input.length && SPACE.has(input[i]!)) i++
  let target: Word | null = null
  if (i < input.length && !BREAK.has(input[i]!) && input[i] !== '(' && input[i] !== ')') {
    target = readWord(input, i, options)
    i = target.end
  }
  const token: Extract<Token, { kind: 'redirect' }> = { kind: 'redirect', op: fd + form, start, end: i, target }
  tokens.push(token)
  if ((form === '<<' || form === '<<-') && target !== null) {
    const raw = input.slice(target.start, target.end)
    pending.push({ token, delimiter: target.text, stripTabs: form === '<<-', quoted: /['"\\]/.test(raw) })
  }
  return i
}

/** Consume a heredoc body after the newline at `i - 1`; returns the index after its delimiter line. */
function readHeredocBody(
  input: string,
  i: number,
  doc: { token: Extract<Token, { kind: 'redirect' }>; delimiter: string; stripTabs: boolean; quoted: boolean },
): number {
  const bodyStart = i
  let lineStart = i
  while (lineStart <= input.length) {
    const newline = input.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? input.length : newline
    let line = input.slice(lineStart, lineEnd)
    if (doc.stripTabs) line = line.replace(/^\t+/, '')
    if (line === doc.delimiter) {
      doc.token.heredoc = { quoted: doc.quoted, body: input.slice(bodyStart, lineStart) }
      return newline === -1 ? input.length : newline
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  // No delimiter line: the body runs to the end of input.
  doc.token.heredoc = { quoted: doc.quoted, body: input.slice(bodyStart) }
  return input.length
}

/** The index after the parenthesis group opening at `open`, quote-aware; the input's end when unbalanced. */
function balancedEnd(input: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let j = open; j < input.length; j++) {
    const c = input[j]!
    if (quote !== '') {
      if (c === '\\' && quote === '"') { j++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '\\') { j++; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j + 1
  }
  return input.length
}

/** An expansion starting at `i` (`$(…)`, `$((…))`, `${…}`, `$name`, `$1`, `$?`, backticks); its end index. */
function expansionEnd(input: string, i: number): number {
  if (input[i] === '`') {
    for (let j = i + 1; j < input.length; j++) {
      if (input[j] === '\\') { j++; continue }
      if (input[j] === '`') return j + 1
    }
    return input.length
  }
  const next = input[i + 1]
  if (next === '(') return balancedEnd(input, i + 1)
  if (next === '{') {
    let depth = 0
    for (let j = i + 1; j < input.length; j++) {
      if (input[j] === '\\') { j++; continue }
      if (input[j] === '{') depth++
      else if (input[j] === '}' && --depth === 0) return j + 1
    }
    return input.length
  }
  if (next === '[') {
    const close = input.indexOf(']', i + 2)
    return close === -1 ? input.length : close + 1
  }
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(input.slice(i + 1, i + 65))
  return name === null ? i + 1 : i + 1 + name[0].length
}

/** Read one word from `start`; quotes, escapes, and expansions stay inside it. */
function readWord(input: string, start: number, options: LexOptions): Word {
  let i = start
  let text = ''
  let literal = true
  let parens = 0
  let braceOpen = false
  let braceSep = false
  /** The previous unquoted character, for `=~` and `:~` tilde expansion. */
  let previous = ''
  while (i < input.length) {
    const c = input[i]!
    if (parens === 0 && (BREAK.has(c) || c === ')')) break
    if (c === "'") {
      const close = input.indexOf("'", i + 1)
      if (close === -1) { text += input.slice(i + 1); literal = false; i = input.length; break }
      text += input.slice(i + 1, close)
      i = close + 1
      previous = ''
      continue
    }
    if (c === '"') {
      i++
      let closed = false
      while (i < input.length) {
        const d = input[i]!
        if (d === '"') { closed = true; i++; break }
        if (d === '\\' && i + 1 < input.length) {
          const e = input[i + 1]!
          if (e === '\n') { i += 2; continue }
          if (e === '$' || e === '`' || e === '"' || e === '\\') { text += e; i += 2; continue }
          text += d
          i++
          continue
        }
        if (d === '$' || d === '`') {
          const end = expansionEnd(input, i)
          text += input.slice(i, end)
          literal = false
          i = end
          continue
        }
        text += d
        i++
      }
      if (!closed) literal = false
      previous = ''
      continue
    }
    if (c === '\\') {
      if (i + 1 >= input.length) { i++; break }
      if (input[i + 1] !== '\n') text += input[i + 1]!
      i += 2
      previous = ''
      continue
    }
    if (c === '$' && (input[i + 1] === "'" || input[i + 1] === '"')) {
      // ANSI-C and locale strings: escapes or translation the parser never evaluates.
      const quote = input[i + 1]!
      let j = i + 2
      while (j < input.length && input[j] !== quote) j += input[j] === '\\' ? 2 : 1
      const end = Math.min(j + 1, input.length)
      text += input.slice(i, end)
      literal = false
      i = end
      previous = ''
      continue
    }
    if (c === '$' || c === '`') {
      const end = expansionEnd(input, i)
      text += input.slice(i, end)
      literal = false
      i = end
      previous = ''
      continue
    }
    if (c === '~') {
      const atStart = i === start
      const next = input[i + 1]
      const plain = next === undefined || next === '/' || BREAK.has(next) || next === ')'
      if (atStart && plain && options.home !== undefined) {
        text += options.home
      } else {
        if (atStart || previous === '=' || previous === ':') literal = false
        text += c
      }
      i++
      previous = c
      continue
    }
    if (c === '*' || c === '?' || c === '[') literal = false
    if (c === '(') { parens++; literal = false }
    if (c === ')') parens--
    if (c === '{') braceOpen = true
    if (braceOpen && (c === ',' || (c === '.' && input[i + 1] === '.'))) braceSep = true
    text += c
    previous = c
    i++
  }
  if (braceOpen && braceSep) literal = false
  return { text, literal, start, end: i }
}
