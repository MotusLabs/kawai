// Test kit for review-convergence: read a change's open diagnosis and its
// card, and record a decision on it straight through the store — the
// executor applies it from rows (decision 5), whoever wrote them.
import type { Database } from 'bun:sqlite'
import type { PlanDecision } from '../../shared/planDecisions'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DiagnosisStore, type DiagnosisRow } from '../plans/execution/diagnosisStore'

export function openDiagnosis(db: Database, executionId: string, change: string): DiagnosisRow | null {
  return new DiagnosisStore(db).open(executionId, change)
}

/** Record `choice` (an exact option) on the change's open diagnosis card, as the Lead's answer, or the owner's override. */
export function decideDiagnosis(db: Database, teamId: string, executionId: string, change: string, choice: string, input: {
  kind?: 'answer' | 'override'
  rationale?: string
} = {}): PlanDecision {
  const diagnosis = new DiagnosisStore(db).ofChange(executionId, change).at(-1)
  if (diagnosis === undefined) throw new Error(`no diagnosis for ${change}`)
  const decisions = new DecisionStore(db)
  const card = decisions.card(teamId, diagnosis.cardId)!
  const index = card.options.indexOf(choice)
  if (index < 0) throw new Error(`"${choice}" is not an option: ${card.options.join(' | ')}`)
  const seq = decisions.decisionsOfCard(teamId, card.id).length + 1
  const kind = input.kind ?? 'answer'
  return decisions.insertDecision({
    cardId: card.id, planId: card.planId, teamId, seq, kind, choice, optionIndex: index + 1, rationale: input.rationale ?? 'decided in the test',
    decidedBy: kind === 'override' ? { kind: 'human', session: null, group: null, profile: null } : { kind: 'agent', session: 'lead-1', group: card.addressedGroup, profile: null },
    affected: [],
  })
}
