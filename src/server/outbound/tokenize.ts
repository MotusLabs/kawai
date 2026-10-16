// The shell tokenizer (execution-safety-recovery D4): tokenize with shell
// quoting rules — single and double quotes, backslash escapes, ANSI-C
// $'…' strings, `$(…)` and backticks kept as opaque words — with each token
// carrying its source span so a segment can keep its original text. Split
// out of `parse.ts` when that file outgrew the 500-LOC rule. Pure.
export interface Token {
  kind: 'word' | 'op'
  text: string
  /** Where the token sits in the source: its span keeps quotes intact (D4). */
  start: number
  end: number
  /** A word holding unexpanded shell text (`$VAR`, `$(…)`, backticks). */
  opaque?: boolean
}

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
    if (char === '$' && input[i + 1] === "'") {
      // ANSI-C quoting: read to the first unescaped quote, verbatim.
      let at = i + 2
      let text = "$'"
      while (at < input.length) {
        if (input[at] === '\\' && at + 1 < input.length) { text += input.slice(at, at + 2); at += 2; continue }
        if (input[at] === "'") { text += "'"; at++; break }
        text += input[at]!
        at++
      }
      word += text
      i = at
      atWordStart = false
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

