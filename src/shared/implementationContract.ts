// The implementation contract (implementation-contract design D1, D2): the
// five parts a task revision may carry, their one Markdown grammar, the
// fence-aware section locator, the parser that reports every problem with
// its line, the canonical renderer, and the canonical hash inputs. Pure and
// SDK-independent, so the server, the client's live editor, plan validation,
// and execution share one grammar. Hashing itself (sha256) happens on the
// server (`src/server/team/contractHash.ts`), like every other hash here:
// shared modules stay free of `node:crypto`.
//
// The grammar, in short: a `## Implementation contract` heading outside any
// fenced block, then `###` part headings in a fixed order, each followed by
// bullets — `- <id>: <text>` for clauses (continued on lines indented by at
// least two spaces), one glob per bullet for Scope. Blank lines are ignored;
// any other line in the section is a problem. The section ends at the next
// `#` or `##` heading outside a fence, or at the end of the text.
import { canonicalJson } from './productStrategy'

export interface ContractClause {
  id: string
  text: string
}

export interface ImplementationContract {
  version: 1
  acceptance: ContractClause[]
  invariants: ContractClause[]
  scope: string[]
  verification: ContractClause[]
  excluded: ContractClause[]
}

export type ContractPartKey = 'acceptance' | 'invariants' | 'scope' | 'verification' | 'excluded'

export interface ContractPart {
  key: ContractPartKey
  heading: string
  /** The clause-id letter; null for Scope, whose entries are globs. */
  letter: string | null
  /** Whether the part needs at least one entry. */
  required: boolean
}

/** The parts in their required order. */
export const CONTRACT_PARTS: readonly ContractPart[] = [
  { key: 'acceptance', heading: 'Acceptance', letter: 'A', required: true },
  { key: 'invariants', heading: 'Invariants', letter: 'I', required: false },
  { key: 'scope', heading: 'Scope', letter: null, required: true },
  { key: 'verification', heading: 'Verification', letter: 'V', required: true },
  { key: 'excluded', heading: 'Excluded', letter: 'X', required: false },
]

export const CONTRACT_HEADING = '## Implementation contract'

export const CONTRACT_LIMITS = {
  /** UTF-8 bytes of the rendered (normalized) contract. */
  bytes: 16_384,
  clausesPerPart: 50,
  globs: 40,
  clauseChars: 1_000,
} as const

export interface ContractProblem {
  /** 1-based line in the text given to the parser. */
  line: number
  message: string
}

/** A parse yields a contract or problems, never both. */
export type ContractParse =
  | { contract: ImplementationContract; problems: [] }
  | { contract: null; problems: ContractProblem[] }

export type ContractSection =
  | { found: true; /** 1-based line of the section heading. */ headingLine: number; /** The lines after the heading, up to the section end. */ body: string[] }
  | { found: false; problems: ContractProblem[] }

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/)

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const SECTION_END = /^#{1,2}(\s|$)/

/**
 * Find the `## Implementation contract` section outside fenced blocks
 * (G15–G18). A second section heading is a problem at its line (G17).
 */
export function locateContractSection(markdown: string): ContractSection {
  const lines = splitLines(markdown)
  let fence: { char: string; length: number } | null = null
  let headingLine = 0
  let body: string[] = []
  let inSection = false
  const problems: ContractProblem[] = []
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = { char: marker[0], length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null
      if (inSection) body.push(line)
      return
    }
    if (fence !== null) {
      if (inSection) body.push(line)
      return
    }
    if (line.trimEnd() === CONTRACT_HEADING) {
      if (headingLine !== 0) problems.push({ line: index + 1, message: 'A second Implementation contract section; keep exactly one' })
      else { headingLine = index + 1; inSection = true; body = [] }
      return
    }
    if (inSection && SECTION_END.test(line)) { inSection = false; return }
    if (inSection) body.push(line)
  })
  if (headingLine === 0) return { found: false, problems: [{ line: 1, message: 'No Implementation contract section (`## Implementation contract`)' }] }
  if (problems.length > 0) return { found: false, problems }
  return { found: true, headingLine, body }
}

/** Why a scope glob is refused, or null when it is allowed (G12, G13). */
export function globProblem(glob: string): string | null {
  if (glob === '') return 'is empty'
  if (glob.startsWith('/')) return 'is an absolute path'
  if (glob.includes('\\')) return 'contains a backslash'
  const forbidden = [...glob].find(char => '![]{}`'.includes(char))
  if (forbidden !== undefined) return `contains \`${forbidden}\``
  for (const segment of glob.split('/')) {
    if (segment === '') return 'has an empty path segment'
    if (segment === '.' || segment === '..') return `has a \`${segment}\` segment`
    if (segment.includes('**') && segment !== '**') return 'uses `**` inside a segment'
  }
  return null
}

const CLAUSE_BULLET = /^- (\S*?):(?:\s(.*))?$/
const CLAUSE_ID = /^([A-Z])([1-9][0-9]*)$/

interface DraftClause { id: string; text: string; line: number }
interface DraftPart { headingLine: number; clauses: DraftClause[]; globs: Array<{ glob: string; line: number }> }

/**
 * Parse the contract section of `markdown` (a whole `design.md`, or just the
 * section). Every problem is reported, sorted by line (G19); any problem
 * yields no contract.
 */
export function parseContract(markdown: string): ContractParse {
  const section = locateContractSection(markdown)
  if (!section.found) return { contract: null, problems: section.problems }
  const problems: ContractProblem[] = []
  const parts = new Map<ContractPartKey, DraftPart>()
  let current: ContractPart | null = null
  let highest = -1
  let last: DraftClause | null = null
  const seenIds = new Set<string>()

  section.body.forEach((line, offset) => {
    const lineNo = section.headingLine + 1 + offset
    if (line.trim() === '') return
    if (line.startsWith('### ')) {
      const name = line.slice(4).trim()
      const index = CONTRACT_PARTS.findIndex(part => part.heading === name)
      last = null
      if (index === -1) { problems.push({ line: lineNo, message: `Unknown part heading \`### ${name}\`; the parts are ${CONTRACT_PARTS.map(p => p.heading).join(', ')}` }); current = null; return }
      const part = CONTRACT_PARTS[index]
      if (parts.has(part.key)) { problems.push({ line: lineNo, message: `Duplicate ${part.heading} heading` }); current = part; return }
      if (index < highest) problems.push({ line: lineNo, message: `${part.heading} heading is out of order; the order is ${CONTRACT_PARTS.map(p => p.heading).join(', ')}` })
      highest = Math.max(highest, index)
      parts.set(part.key, { headingLine: lineNo, clauses: [], globs: [] })
      current = part
      return
    }
    if (/^ {2,}\S/.test(line) || /^\t+\S/.test(line)) {
      if (last === null) problems.push({ line: lineNo, message: 'An indented line continues no clause' })
      else last.text = last.text === '' ? line.trim() : `${last.text} ${line.trim()}`
      return
    }
    if (line.startsWith('- ') || line === '-') {
      last = null
      if (current === null) { problems.push({ line: lineNo, message: 'A bullet outside any part heading' }); return }
      const draft = parts.get(current.key)
      if (draft === undefined) return
      if (current.letter === null) {
        let glob = line.slice(2).trim()
        if (/^`[^`]+`$/.test(glob)) glob = glob.slice(1, -1)
        const why = globProblem(glob)
        if (why !== null) problems.push({ line: lineNo, message: `Scope glob \`${glob}\` ${why}` })
        else draft.globs.push({ glob, line: lineNo })
        return
      }
      const bullet = CLAUSE_BULLET.exec(line)
      if (bullet === null) { problems.push({ line: lineNo, message: `A ${current.heading} clause is written \`- ${current.letter}<n>: <text>\`` }); return }
      const id = bullet[1]
      const idMatch = CLAUSE_ID.exec(id)
      if (idMatch === null) { problems.push({ line: lineNo, message: `\`${id}\` is not a clause id; ids are a letter and a number from 1, like ${current.letter}1` }); return }
      if (idMatch[1] !== current.letter) { problems.push({ line: lineNo, message: `${id} is not ${article(current.heading)} ${current.heading} id; ${current.heading} ids start with ${current.letter}` }); return }
      if (seenIds.has(id)) { problems.push({ line: lineNo, message: `Duplicate clause id ${id}` }); return }
      seenIds.add(id)
      const clause: DraftClause = { id, text: (bullet[2] ?? '').trim(), line: lineNo }
      draft.clauses.push(clause)
      last = clause
      return
    }
    last = null
    problems.push({ line: lineNo, message: 'Only part headings and bullets belong in the contract' })
  })

  for (const part of CONTRACT_PARTS) {
    const draft = parts.get(part.key)
    if (draft === undefined) { problems.push({ line: section.headingLine, message: `Missing \`### ${part.heading}\` heading` }); continue }
    const count = part.letter === null ? draft.globs.length : draft.clauses.length
    if (part.required && count === 0) problems.push({ line: draft.headingLine, message: part.letter === null ? 'Scope needs at least one glob' : `${part.heading} needs at least one clause` })
    if (part.letter === null && count > CONTRACT_LIMITS.globs) problems.push({ line: draft.headingLine, message: `Scope has ${count} globs; the limit is ${CONTRACT_LIMITS.globs}` })
    if (part.letter !== null && count > CONTRACT_LIMITS.clausesPerPart) problems.push({ line: draft.headingLine, message: `${part.heading} has ${count} clauses; the limit is ${CONTRACT_LIMITS.clausesPerPart}` })
    for (const clause of draft.clauses) {
      if (clause.text === '') problems.push({ line: clause.line, message: `${clause.id} has no text` })
      else if (clause.text.length > CONTRACT_LIMITS.clauseChars) problems.push({ line: clause.line, message: `${clause.id} is ${clause.text.length} characters; the limit is ${CONTRACT_LIMITS.clauseChars}` })
    }
  }
  if (problems.length > 0) return { contract: null, problems: sortProblems(problems) }

  const clauses = (key: ContractPartKey) => (parts.get(key)?.clauses ?? []).map(({ id, text }) => ({ id, text }))
  const contract: ImplementationContract = {
    version: 1,
    acceptance: clauses('acceptance'),
    invariants: clauses('invariants'),
    scope: (parts.get('scope')?.globs ?? []).map(entry => entry.glob),
    verification: clauses('verification'),
    excluded: clauses('excluded'),
  }
  const bytes = new TextEncoder().encode(renderContract(contract)).length
  if (bytes > CONTRACT_LIMITS.bytes) return { contract: null, problems: [{ line: section.headingLine, message: `The contract is ${bytes} bytes; the limit is ${CONTRACT_LIMITS.bytes}` }] }
  return { contract, problems: [] }
}

const article = (word: string) => (/^[AEIOU]/.test(word) ? 'an' : 'a')

const sortProblems = (problems: ContractProblem[]) =>
  problems.map((problem, index) => ({ problem, index }))
    .sort((a, b) => a.problem.line - b.problem.line || a.index - b.index)
    .map(entry => entry.problem)

/** The canonical Markdown (D2): one bullet per clause, globs in backticks. */
export function renderContract(contract: ImplementationContract): string {
  const lines = [CONTRACT_HEADING]
  for (const part of CONTRACT_PARTS) {
    lines.push('', `### ${part.heading}`)
    if (part.key === 'scope') for (const glob of contract.scope) lines.push(`- \`${glob}\``)
    else for (const clause of contract[part.key]) lines.push(`- ${clause.id}: ${clause.text}`)
  }
  return `${lines.join('\n')}\n`
}

/** The sha256 input of a contract's hash (D2). */
export function contractHashInput(contract: ImplementationContract): string {
  return canonicalJson(contract)
}

/** The sha256 input of a revision's text identity, when it has no contract (D2). */
export function textIdentityInput(direction: string, acceptance: string | null): string {
  return canonicalJson({ kind: 'text', direction, acceptance })
}

/** `r<revision>#<first 12 hex digits>` — a contract's or a revision's identity. */
export function revisionIdentity(revision: number, hash: string): string {
  return `r${revision}#${hash.slice(0, 12)}`
}

/** A clause's identity: the contract identity, ` › `, the clause id. */
export function clauseIdentity(identity: string, clauseId: string): string {
  return `${identity} › ${clauseId}`
}
