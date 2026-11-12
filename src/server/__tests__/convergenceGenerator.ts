// Seeded review generator for the review-convergence properties (P2, P4):
// over a task's ledger as it stands, one counted review that resolves or
// keeps open each blocking finding, sometimes regresses a resolved one,
// raises up to two new findings on two clauses and an excluded one (X1, out
// of contract), and sometimes re-raises a resolved one; about one review in
// twelve resolves everything (a pass). The task carries CONTRACT
// (CONTRACT_MARKDOWN through the task tools).
import { blocking, type LedgerRow, type SubmittedDisposition, type SubmittedFinding } from '../../shared/findingsLedger'
import { parseContract } from '../../shared/implementationContract'

export const CONTRACT_MARKDOWN = ['## Implementation contract', '### Acceptance', '- A1: Exports rows', '- A2: Pins revisions', '### Invariants', '- I1: Never twice',
  '### Scope', '- `src/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: No metrics'].join('\n')
export const CONTRACT = parseContract(CONTRACT_MARKDOWN).contract!

export type Rng = () => number
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!

/** One review's findings and dispositions over `rows`, the task's ledger now; `n` keeps evidence distinct. */
export function nextReview(rng: Rng, rows: readonly LedgerRow[], n: number): { findings: SubmittedFinding[]; dispositions: SubmittedDisposition[] } {
  const open = blocking(rows)
  if (rng() < 0.08) return { findings: [], dispositions: open.map(row => ({ id: row.id, disposition: 'resolved' as const })) }
  const dispositions: SubmittedDisposition[] = open.map(row => (rng() < 0.35
    ? { id: row.id, disposition: 'resolved' as const }
    : { id: row.id, disposition: 'still-open' as const, evidence: `src/${row.id}.ts:${n} still wrong` }))
  const resolved = rows.filter(row => row.state === 'resolved')
  if (resolved.length > 0 && rng() < 0.5) dispositions.push({ id: pick(rng, resolved).id, disposition: 'regressed', evidence: `src/r.ts:${n} broke again` })
  const items: SubmittedFinding[] = []
  const fresh = Math.floor(rng() * 3)
  for (let index = 0; index < fresh; index++) {
    items.push({ level: pick(rng, ['P0', 'P1', 'P1', 'P2'] as const), clause: pick(rng, ['A1', 'A2', 'A2', 'X1']), evidence: `src/f${n}-${index}.ts:${index + 1} wrong`, impact: 'wrong output' })
  }
  const reraisable = resolved.filter(row => !dispositions.some(entry => entry.id === row.id))
  if (reraisable.length > 0 && rng() < 0.4) {
    const row = pick(rng, reraisable)
    items.push({ id: row.id, level: 'P1', clause: row.clauseId ?? 'A1', evidence: `src/${row.id}.ts:${n} back again`, impact: 'wrong output' })
  }
  return { findings: items, dispositions }
}
