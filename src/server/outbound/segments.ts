// Simple commands from the lexer's tokens (execution-safety-recovery D4): a
// command ends at `;`, `&&`, `||`, `|`, `|&`, `&`, a newline, or a grouping
// bracket, and remembers the operator that ended it (the walker's cwd
// certainty follows `&&` chains) and its pipeline. Redirections stay beside
// the words — their targets still count for the literal check — and a
// heredoc's body joins the command's searchable text for the backstop.
// Leading reserved words are stripped here; a compound keyword or a grouping
// bracket anywhere marks the whole call, which the context check reads. Pure.
import { tokenize, type Heredoc, type LexOptions, type Word } from './tokenize'

export interface Redirect {
  op: string
  target: Word | null
  heredoc?: Heredoc
}

export interface SimpleCommand {
  /** The command words, leading reserved words stripped, redirections removed. */
  words: Word[]
  redirects: Redirect[]
  /** The source span, quotes and redirections included (what a match stores). */
  text: string
  /** The span plus every heredoc body (what the backstop searches). */
  searchText: string
  /** The operator that ended the command; null at the end of input. */
  connector: string | null
  /** Commands joined by `|` share one pipeline id. */
  pipeline: number
  /** How many `(` subshells enclose the command: their cd never reaches the parent. */
  subshell: number
}

export interface ParsedCall {
  commands: SimpleCommand[]
  /** A subshell or brace group appears anywhere in the call. */
  grouped: boolean
  /** A compound command (if, for, while, case, …) appears anywhere in the call. */
  compound: boolean
}

/** Pipeline prefixes: they never change what runs. */
const PREFIXES = new Set(['!', 'time'])
/** Compound-command keywords: what runs depends on conditions the parser never evaluates. */
const COMPOUND = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'coproc', 'in'])
const GROUPING = new Set(['(', ')', '{', '}'])

/** Split a command string into simple commands. */
export function parseCall(command: string, options: LexOptions = {}): ParsedCall {
  const tokens = tokenize(command, options)
  const commands: SimpleCommand[] = []
  let grouped = false
  let compound = false
  let pipeline = 0
  const open: string[] = []
  let words: Word[] = []
  let redirects: Redirect[] = []
  let start = -1
  let end = -1
  const finish = (connector: string | null) => {
    // Reserved words lead; a compound keyword marks the call.
    let at = 0
    while (at < words.length && words[at]!.literal && (PREFIXES.has(words[at]!.text) || COMPOUND.has(words[at]!.text))) {
      if (COMPOUND.has(words[at]!.text)) compound = true
      at++
    }
    // `time -p` is a prefix with its flag.
    if (at > 0 && words[at - 1]!.text === 'time' && words[at]?.text === '-p') at++
    const kept = words.slice(at)
    if (kept.length > 0 || redirects.length > 0) {
      const text = start === -1 ? '' : command.slice(start, end)
      const bodies = redirects.flatMap(redirect => redirect.heredoc === undefined ? [] : [redirect.heredoc.body])
      commands.push({
        words: kept,
        redirects,
        text,
        searchText: bodies.length === 0 ? text : [text, ...bodies].join('\n'),
        connector,
        pipeline,
        subshell: open.filter(bracket => bracket === '(').length,
      })
    }
    if (connector !== '|' && connector !== '|&') pipeline++
    words = []
    redirects = []
    start = -1
    end = -1
  }
  for (const token of tokens) {
    if (token.kind === 'op') {
      if (GROUPING.has(token.text)) grouped = true
      finish(token.text)
      if (token.text === '(' || token.text === '{') open.push(token.text)
      else if (token.text === ')' || token.text === '}') open.pop()
      continue
    }
    const span = token.kind === 'word' ? token.word : token
    if (start === -1) start = span.start
    end = span.end
    if (token.kind === 'word') words.push(token.word)
    else redirects.push({ op: token.op, target: token.target, ...(token.heredoc === undefined ? {} : { heredoc: token.heredoc }) })
  }
  finish(null)
  return { commands, grouped, compound }
}
