// Diagnosis cards (review-convergence decision 6): the card Kawai raises in
// its own name when a change's review rounds stop converging. Written inside
// the caller's transaction — the executor's open step — through the stores,
// so the diagnosis row, the card, its mail, and the stall-alert row stand or
// fall together. Addressed to the plan's Lead role (Kawai is never in it),
// else the owner with no mail. The options are closed: `resolveChoice`
// refuses free text on a `diagnosis` card, and its decision sends no answer
// mail — the outcome is the reply. `diagnosisOutcome` reads a choice back.
import type { DecisionCard, PlanDecision } from '../../../shared/planDecisions'
import { signalFindings, signalLine, type DiagnosisSignal } from '../../../shared/reviewConvergence'
import type { LedgerRow } from '../../../shared/findingsLedger'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { PlanStore } from '../planStore'
import { planLead, STALL_TAG } from '../supervision/stallAlerts'
import type { DecisionStore } from './decisionStore'
import type { TaskStore } from '../../team/taskStore'
import { DiagnosisStore } from '../execution/diagnosisStore'
import { SYSTEM_ACTOR } from '../../../shared/team'
import { CONTEXT_MAX, OPTIONS_MAX, QUESTION_MAX } from './decisionInputs'

export const FIX_ROUND = 'Fix round'
export const AMEND_CONTRACT = 'Amend the contract'
export const ESCALATE = 'Escalate'
export const REJECT_MAX = 10
export const REASSIGN_MAX = 4
export const DIAGNOSIS_ASKER = { session: 'kawai', group: null, profile: null } as const

export type DiagnosisOutcome =
  | { kind: 'fix' }
  | { kind: 'reject'; ids: string[] }
  | { kind: 'amend' }
  | { kind: 'reassign'; group: string }
  | { kind: 'escalate' }

/**
 * The blocking findings `Reject` names: those the signals name, or, when the
 * signals name no finding at all (S4, the backstop), every blocking finding;
 * sorted by number, at most ten.
 */
export function rejectable(signals: readonly DiagnosisSignal[], ledger: readonly LedgerRow[], isBlocking: (row: LedgerRow) => boolean): string[] {
  const named = signalFindings(signals)
  const blockingIds = ledger.filter(isBlocking).map(row => row.id)
  const ids = named.length > 0 ? blockingIds.filter(id => named.includes(id)) : blockingIds
  return ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).slice(0, REJECT_MAX)
}

/** The card's options, in the spec's order ("A diagnosis card offers the outcomes that apply"). */
export function diagnosisOptions(input: { reject: readonly string[]; reassignTo: readonly string[] }): string[] {
  return [
    FIX_ROUND,
    ...(input.reject.length > 0 ? [`Reject ${input.reject.join(', ')}`] : []),
    AMEND_CONTRACT,
    ...input.reassignTo.slice(0, REASSIGN_MAX).map(group => `Reassign to ${group}`),
    ESCALATE,
  ].slice(0, OPTIONS_MAX)
}

/** The other groups the execution's plan revision names for a change, in plan order. */
export function reassignTargets(changes: ReadonlyArray<{ group: string | null }>, current: string | null): string[] {
  const groups: string[] = []
  for (const entry of changes) {
    if (entry.group !== null && entry.group !== current && !groups.includes(entry.group)) groups.push(entry.group)
  }
  return groups.slice(0, REASSIGN_MAX)
}

/** Read a recorded choice back as its outcome; null for anything else (never written: the card is closed). */
export function diagnosisOutcome(choice: string): DiagnosisOutcome | null {
  if (choice === FIX_ROUND) return { kind: 'fix' }
  if (choice === AMEND_CONTRACT) return { kind: 'amend' }
  if (choice === ESCALATE) return { kind: 'escalate' }
  if (choice.startsWith('Reject ')) return { kind: 'reject', ids: choice.slice('Reject '.length).split(',').map(id => id.trim()).filter(Boolean) }
  if (choice.startsWith('Reassign to ')) return { kind: 'reassign', group: choice.slice('Reassign to '.length).trim() }
  return null
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The question and context: the signals, the counts by review, and the findings involved with their clauses. */
export function diagnosisText(input: {
  plan: { id: string; title: string }
  change: string
  signals: readonly DiagnosisSignal[]
  counts: readonly number[]
  findings: ReadonlyArray<Pick<LedgerRow, 'id' | 'level' | 'state' | 'clause'>>
}): { question: string; context: string } {
  const question = [
    `Kawai: change ${input.change} of plan "${input.plan.title}" (${input.plan.id}) needs a diagnosis instead of another fix round.`,
    ...input.signals.map(signal => `- ${signalLine(signal)}`),
    `Open blocking count by review: ${input.counts.length > 0 ? input.counts.join(', ') : 'no reviews in the window'}.`,
    'Decide with decision_record, giving option_index and a rationale. The decision is the instruction: Kawai acts on it.',
  ].join('\n')
  const context = input.findings.length === 0 ? 'No finding is named.' : [
    'Findings involved:',
    ...input.findings.map(row => `- ${row.id} ${row.level} ${row.state}${row.clause ? ` on ${row.clause}` : ''}`),
  ].join('\n')
  return { question: cut(question, QUESTION_MAX), context: cut(context, CONTEXT_MAX) }
}

export interface DiagnosisCardDeps {
  decisions: DecisionStore
  mail: Pick<MailboxStore, 'enqueue'>
  plans: Pick<PlanStore, 'approvedRevision' | 'revision'>
}

/**
 * Raise the card and its mail inside the caller's transaction. The mail goes
 * from Kawai to the plan's Lead role under the role's profiles, tagged
 * `decision-question`, `plan-stall`, and `stall:convergence`; it is the
 * convergence episode's one alert (plan-supervision, "A stall alerts the
 * Lead role once per episode"). With no Lead role the card is the owner's
 * and no mail is sent.
 */
export function raiseDiagnosisCard(deps: DiagnosisCardDeps, input: {
  team: TeamIdentity
  planId: string
  revision: number
  change: string
  taskId: string
  question: string
  context: string
  options: string[]
}): DecisionCard {
  const approved = deps.plans.approvedRevision(input.planId)
  const { lead, role } = planLead(approved?.content)
  const message = lead === null ? null : deps.mail.enqueue({
    teamId: input.team.teamId, toKind: 'group', toId: lead, fromKind: 'system', fromSession: null, fromGroup: null, originPath: input.team.groupsRoot,
    tags: ['decision-question', STALL_TAG, 'stall:convergence'], taskId: null, actor: 'system',
    body: `${input.question}\n\nOptions:\n${input.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n\n${input.context}`,
    ...(role?.profiles.length ? { allowedProfiles: role.profiles } : {}),
  })
  return deps.decisions.insertCard({
    kind: 'diagnosis', teamId: input.team.teamId, planId: input.planId, revision: input.revision, change: input.change, taskId: input.taskId,
    question: input.question, options: input.options, context: input.context, askedBy: { ...DIAGNOSIS_ASKER },
    addressedTo: lead === null ? 'owner' : 'lead', addressedGroup: lead, messageId: message?.id ?? null,
  })
}

/**
 * A decision on a diagnosis card whose diagnosis already closed (review-
 * convergence 5.3, invariant I5): the stage never applies it, so the task
 * journals it — inside the decision's own transaction — and nothing is
 * dispatched. An override still creates its forward-fix task as for any card.
 */
export function journalLateDiagnosisDecision(deps: { decisions: Pick<DecisionStore, 'db'>; taskStore: Pick<TaskStore, 'appendJournal'> }, card: DecisionCard, decision: PlanDecision): boolean {
  if (card.kind !== 'diagnosis' || card.taskId === null) return false
  const diagnosis = new DiagnosisStore(deps.decisions.db).forCard(card.id)
  if (diagnosis === null || diagnosis.closedAt === null) return false
  deps.taskStore.appendJournal(card.taskId, SYSTEM_ACTOR,
    `Decision ${decision.id} on card ${card.id} (${decision.choice}) came after diagnosis ${diagnosis.id} closed (${diagnosis.outcome ?? diagnosis.closeReason}); Kawai applies nothing for it`)
  return true
}
