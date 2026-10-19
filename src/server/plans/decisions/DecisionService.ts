// Decision service (plan-supervision design D4–D6): the agent's
// `decision_ask` and `decision_record`, and the owner's answer and override
// (`ownerDecisions.ts`). Cards and decisions are written only here, through
// `DecisionStore`, each command in one transaction with the mail it sends:
// the mailbox's prepared paths run their checks first and write inside the
// transaction, so a refusal at any step writes nothing. Answers go through
// the reply path with the reply guard bypassed (D9). Every committed write
// calls `onChange(planId)`, which pushes the plan's detail (D15).
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../../db'
import type { DecisionCard, DecisionParty, PlanDecision } from '../../../shared/planDecisions'
import type { PlanStore } from '../planStore'
import type { PlanService } from '../PlanService'
import type { TaskStore } from '../../team/taskStore'
import type { TaskService } from '../../team/TaskService'
import type { AssignmentService } from '../../team/AssignmentService'
import type { PreparedMail, TeamMailbox } from '../../team/TeamMailbox'
import type { TeamMessage } from '../../team/mailboxStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import { loadTeamGroups } from '../../team/teamGroups'
import { DecisionConflict, type DecisionStore } from './decisionStore'
import { answerBody, askInput, deciderName, DecisionRefusal, questionBody, rationaleOf, resolveChoice } from './decisionInputs'
import { cardScope, leadOf, teamPlan } from './decisionScope'
import { answerAsOwner, overrideAsOwner, type OwnerAnswerInput, type OwnerOverrideInput } from './ownerDecisions'

export type DecisionCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export interface DecisionServiceDeps {
  db: Database
  decisions: DecisionStore
  plans: PlanStore
  planService: PlanService
  tasks: TaskService
  taskStore: TaskStore
  assignments: AssignmentService
  mailbox: TeamMailbox
  getSession: (id: string) => ChatSessionRecord | null | undefined
  homeDir?: string
  onChange?: (planId: string) => void
}

export interface AskInput { question: string; options?: string[]; context?: string | null; plan_id?: string }
export interface RecordInput {
  plan_id: string
  card_id?: string
  question?: string
  options?: string[]
  choice?: string | null
  option_index?: number | null
  rationale: string
  affected_tasks?: string[]
}

export interface DecisionOutcome { card: DecisionCard; decision: PlanDecision; replayed: boolean; message: TeamMessage | null }

export const ASK_GUIDANCE = 'The answer arrives as mail in this thread. Continue other work or end your turn; do not wait in a loop.'

export class DecisionService {
  constructor(readonly deps: DecisionServiceDeps) {}

  /** The asking session and its team; an unknown session is refused. */
  private async agent(sessionId: string) {
    const session = this.deps.getSession(sessionId)
    if (!session) throw new DecisionRefusal('not-found', `Unknown session: ${sessionId}`)
    const { team } = await loadTeamGroups(session.projectPath, this.deps.homeDir)
    const party: DecisionParty = { kind: 'agent', session: session.sessionId, group: session.groupId ?? null, profile: session.claudeProfileId ?? 'default' }
    return { session, team, party }
  }

  /** D4: a card, and for a Lead-addressed one its task-less question mail, in one transaction. */
  async ask(caller: { kind: 'agent'; sessionId: string }, input: AskInput): Promise<{ card: DecisionCard; message: TeamMessage | null; guidance: string }> {
    const fields = askInput(input)
    const { session, team, party } = await this.agent(caller.sessionId)
    const scope = cardScope(this.deps, team.teamId, session, input.plan_id?.trim() || undefined)
    const lead = leadOf(this.deps.plans, scope.plan.id)
    const toLead = lead !== null && session.groupId !== lead
    const draft: DecisionCard = {
      id: `card-${crypto.randomUUID()}`, teamId: team.teamId, planId: scope.plan.id, revision: scope.revision, change: scope.change, taskId: scope.taskId,
      question: fields.question, options: fields.options, context: fields.context, askedBy: { session: session.sessionId, group: party.group, profile: party.profile },
      addressedTo: toLead ? 'lead' : 'owner', addressedGroup: toLead ? lead : null, messageId: null, createdAt: '',
    }
    // No task on the question (D4): `lead` is worktree-scoped, and the card carries the task.
    const prepared = toLead
      ? await this.deps.mailbox.prepareSend(caller, { to_kind: 'group', to_id: lead, body: questionBody(draft, scope.plan.title), tags: ['decision-question'] })
      : null
    const { card, message } = this.deps.decisions.atomically(() => {
      const message = prepared?.commit() ?? null
      return { card: this.deps.decisions.insertCard({ ...draft, messageId: message?.id ?? null }), message }
    })
    const published = message && prepared ? await prepared.after(message) : null
    this.deps.onChange?.(card.planId)
    return { card, message: published, guidance: toLead ? ASK_GUIDANCE : `${ASK_GUIDANCE} The plan has no Lead role reachable from you, so the owner answers it in the Plans view.` }
  }

  /** D5: answer a card addressed to the caller's group, or record the Lead's own call. */
  async record(caller: { kind: 'agent'; sessionId: string }, input: RecordInput): Promise<DecisionOutcome> {
    const { session, team, party } = await this.agent(caller.sessionId)
    const plan = teamPlan(this.deps.plans, team.teamId, String(input.plan_id ?? '').trim())
    const rationale = rationaleOf(input.rationale, true)
    if (!input.card_id) return this.ownCall(session, team.teamId, plan.id, party, input, rationale!)
    const card = this.deps.decisions.card(team.teamId, input.card_id)
    if (!card || card.planId !== plan.id) throw new DecisionRefusal('not-found', `Decision card not found on plan ${plan.id}: ${input.card_id}`)
    if (card.addressedTo === 'owner') throw new DecisionRefusal('forbidden', `Card ${card.id} is addressed to the owner; only the owner answers it, in the Plans view.`)
    if (session.groupId !== card.addressedGroup) {
      throw new DecisionRefusal('forbidden', `Card ${card.id} is addressed to group ${card.addressedGroup}; your group ${session.groupId ?? '(none)'} cannot decide it.`)
    }
    const { choice, optionIndex } = resolveChoice(card.options, input)
    const affected = this.affected(team.teamId, input.affected_tasks, card.taskId)
    const settled = this.settledFor(team.teamId, card, party, choice)
    if (settled) return settled
    const decisionId = `decision-${crypto.randomUUID()}`
    const preview = { id: decisionId, choice, rationale, decidedBy: party } as PlanDecision
    const prepared = card.messageId
      ? await this.deps.mailbox.prepareReply(caller, {
        message_id: card.messageId, body: answerBody(card, preview), tags: ['decision-answer'], ...(card.taskId ? { task_id: card.taskId } : {}),
      }, { answer: true })
      : null
    try {
      return await this.commitDecision(prepared, card, () => this.deps.decisions.insertDecision({
        id: decisionId, cardId: card.id, planId: plan.id, teamId: team.teamId, seq: 1, kind: 'answer', choice, optionIndex, rationale, decidedBy: party, affected,
      }))
    } catch (error) {
      if (error instanceof DecisionConflict && error.kind === 'card-decided') return this.settledFor(team.teamId, card, party, choice) ?? this.refuseDecided(card, error.decision)
      throw error
    }
  }

  /** The owner's answer (D6); agents are refused first. */
  answer(caller: DecisionCaller, input: OwnerAnswerInput): Promise<DecisionOutcome> {
    return answerAsOwner(this, caller, input)
  }

  /** The owner's override (D6), with its fix task (D7); agents are refused first. */
  override(caller: DecisionCaller, input: OwnerOverrideInput): Promise<DecisionOutcome & { fixTaskId: string | null }> {
    return overrideAsOwner(this, caller, input)
  }

  /** Insert, write the mail, and link it, in one transaction; then announce. */
  async commitDecision(prepared: PreparedMail | null, card: DecisionCard, insert: () => PlanDecision, within?: () => void): Promise<DecisionOutcome> {
    const { decision, message } = this.deps.decisions.atomically(() => {
      const decision = insert()
      within?.()
      const message = prepared?.commit() ?? null
      if (message) this.deps.decisions.setReplyMessage(card.teamId, decision.id, message.id)
      return { decision: this.deps.decisions.decision(card.teamId, decision.id)!, message }
    })
    const published = message && prepared ? await prepared.after(message) : null
    this.deps.onChange?.(card.planId)
    return { card, decision, replayed: false, message: published }
  }

  /** A card already decided: the same session's same choice replays; anything else is refused naming the decider. */
  private settledFor(teamId: string, card: DecisionCard, party: DecisionParty, choice: string): DecisionOutcome | null {
    const first = this.deps.decisions.decisionsOfCard(teamId, card.id)[0]
    if (!first) return null
    if (first.decidedBy.kind === 'agent' && first.decidedBy.session === party.session && first.choice === choice) {
      return { card, decision: first, replayed: true, message: null }
    }
    return this.refuseDecided(card, first)
  }

  refuseDecided(card: DecisionCard, decision: PlanDecision | null): never {
    const by = decision ? `${deciderName(decision)} (${decision.id}: ${decision.choice})` : 'another decider'
    throw new DecisionRefusal('state', `Card ${card.id} is already decided by ${by}; nothing was written.`)
  }

  /** D5: the affected tasks, defaulting to the card's; each must be a task of the team. */
  affected(teamId: string, given: string[] | undefined, cardTask: string | null): string[] {
    const ids = given === undefined ? (cardTask ? [cardTask] : []) : [...new Set(given.map(id => String(id).trim()).filter(Boolean))]
    for (const id of ids) {
      if (this.deps.taskStore.get(id)?.teamId !== teamId) throw new DecisionRefusal('not-found', `Task not found in this team: ${id}`)
    }
    return ids
  }

  /** D5 without a card: the Lead's own call, a decided card with no mail. */
  private async ownCall(session: ChatSessionRecord, teamId: string, planId: string, party: DecisionParty, input: RecordInput, rationale: string): Promise<DecisionOutcome> {
    const lead = leadOf(this.deps.plans, planId)
    if (lead === null || session.groupId !== lead) {
      throw new DecisionRefusal('forbidden', `An own call needs the plan's Lead role${lead ? ` (${lead})` : ', and this plan has none'}; give card_id to answer a card addressed to you.`)
    }
    if (!input.question?.trim()) throw new DecisionRefusal('invalid', 'An own call needs the question it decides.')
    const fields = askInput({ question: input.question, options: input.options })
    const { choice, optionIndex } = resolveChoice(fields.options, input)
    const affected = this.affected(teamId, input.affected_tasks, null)
    let card!: DecisionCard
    return this.commitDecision(null, { teamId, planId } as DecisionCard, () => {
      card = this.deps.decisions.insertCard({
        teamId, planId, revision: null, change: null, taskId: null, question: fields.question, options: fields.options, context: null,
        askedBy: { session: session.sessionId, group: party.group, profile: party.profile }, addressedTo: 'lead', addressedGroup: lead, messageId: null,
      })
      return this.deps.decisions.insertDecision({ cardId: card.id, planId, teamId, seq: 1, kind: 'own-call', choice, optionIndex, rationale, decidedBy: party, affected })
    }).then(outcome => ({ ...outcome, card }))
  }
}
