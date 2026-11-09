// What a fix attempt and a review handoff say about findings
// (review-findings-ledger D7). One builder, `fixFindings`, reads the
// ledger's fold for every fix caller — the executor's fixes step, the owed
// re-send, and the republish path — so each lists the blocking findings by
// id with clause, evidence, and reproduction, counts the others, and keeps
// today's text for a round decided on a text row before the upgrade.
// `reviewAsk` is the review handoff's findings block: the contract
// identity, the open findings to dispose of, and the structured form.
import { blocking, type LedgerRow } from '../../../shared/findingsLedger'
import type { TaskStore } from '../../team/taskStore'

export interface FixFindings {
  /** The findings blocking now, in id order, and their rendered lines. */
  blocking: LedgerRow[]
  blockingText: string
  /** Findings that are not blocking but still stand (advisory, unsupported, out of contract, disputed). */
  others: number
  /** Today's rendering: a text row the round was decided on, and Kawai's own notes (a republish, a failed update). */
  legacyTexts: string[]
}

const SETTLED = new Set(['resolved', 'rejected', 'superseded'])

export function ledgerOf(store: TaskStore, taskId: string): LedgerRow[] {
  return store.ledger(taskId)
}

/** D7's shared builder: the fold now, plus the text of a text row the round names. */
export function fixFindings(store: TaskStore, taskId: string, round: { resultId: string; verdictFindingsId: string | null } | null, notes: string[] = []): FixFindings {
  const rows = ledgerOf(store, taskId)
  const open = blocking(rows)
  const others = rows.filter(row => !open.includes(row) && !SETTLED.has(row.state)).length
  const legacyTexts: string[] = [...notes]
  if (round !== null) {
    const all = store.results.findingsFor(round.resultId)
    const decided = round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all.filter(entry => !entry.structured)
    for (const row of decided) if (!row.structured) legacyTexts.push(row.findings)
  }
  return { blocking: open, blockingText: blockingLines(open, evidenceReader(store, taskId)), others, legacyTexts }
}

const cut = (text: string | null, max: number): string => (text === null ? '' : text.length > max ? `${text.slice(0, max)}…` : text)
const BLOCK_CHARS = 4_000

/** One line per blocking finding: `F3 (P1, r2#… › A1): <evidence> — repro: <reproduction>`. */
export function blockingLines(rows: readonly LedgerRow[], evidenceOf: (row: LedgerRow) => { evidence: string | null; reproduction: string | null }): string {
  const lines = rows.map(row => {
    const { evidence, reproduction } = evidenceOf(row)
    return `${row.id} (${row.level}, ${row.clause ?? 'no clause'}): ${cut(evidence, 600)}${reproduction ? ` — repro: ${cut(reproduction, 600)}` : ''}`
  }).join('\n')
  return lines.length > BLOCK_CHARS ? `${lines.slice(0, BLOCK_CHARS)}\n…(cut — task_get has the rest)` : lines
}

/** The newest evidence and reproduction a finding was raised or kept open with. */
export function evidenceReader(store: TaskStore, taskId: string): (row: LedgerRow) => { evidence: string | null; reproduction: string | null } {
  const submissions = store.findings.countedSubmissions(taskId)
  return row => {
    for (const submission of [...submissions].reverse()) {
      const item = submission.items.find(entry => entry.findingId === row.id && (entry.evidence !== null || entry.reproduction !== null))
      if (item) return { evidence: item.evidence, reproduction: item.reproduction }
    }
    return { evidence: null, reproduction: null }
  }
}

/** The review handoff's findings block (D7): what it is judged under, what to dispose of, and how to answer. */
export function reviewAsk(store: TaskStore, taskId: string, resultId: string): string[] {
  const task = store.get(taskId)
  const result = store.results.get(resultId)
  const pinned = result ? store.revisions(taskId).find(entry => entry.revision === result.taskRevision) : undefined
  const identity = pinned?.identity ?? task?.identity ?? null
  const open = blocking(ledgerOf(store, taskId))
  return [
    identity ? `Judge it under contract identity ${identity}; cite its clauses${pinned?.contract ? ' (A…, I…, V…)' : ' (this revision has no contract: cite the identity itself)'}.` : null,
    open.length > 0
      ? `Open findings — give each a disposition (resolved, still-open with evidence, or regressed):\n${open.map(row => `- ${row.id} (${row.level}, ${row.clause ?? 'no clause'})`).join('\n')}`
      : null,
    `Submit structured findings with task_submit_findings on task ${taskId} for result ${resultId}: items (each with level P0/P1/P2, clause, evidence as file:line, impact, and reproduction when you have one) and a disposition for every open finding. The verdict is derived from the ledger; text alone is refused.`,
  ].filter((line): line is string => line !== null)
}
