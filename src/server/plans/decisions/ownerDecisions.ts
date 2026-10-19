// The owner's answer and override (plan-supervision design D6), both human
// only and both replayed by `(plan_id, command_id)` over their compared
// fields. An answer decides an open card, cancels its question mail while it
// is still queued or awaiting a request (claimed or delivered mail is left
// alone), and sends the asker the answer in the question's thread. An
// override is compare-and-swap on the decision the owner read, and commits
// in one transaction: a completed plan's reopen (through
// `PlanService.reopenWithin`, the only writer of plan events), the decision
// `seq + 1`, the cancel of an earlier open fix, and the new fix task with its
// dispatch (`fixTasks.ts`). It sends the asker no mail.
import type { DecisionCard, DecisionParty, PlanDecision } from '../../../shared/planDecisions'
import { loadGroupCatalog } from '../../team/groupCatalog'
import type { PreparedMail } from '../../team/TeamMailbox'
import { DecisionConflict } from './decisionStore'
import { answerBody, DecisionRefusal, payloadDiff, rationaleOf, resolveChoice } from './decisionInputs'
import { teamPlan } from './decisionScope'
import { prepareOverrideFix } from './fixTasks'
import type { DecisionCaller, DecisionOutcome, DecisionService } from './DecisionService'

export interface OwnerAnswerInput { planId: string; cardId: string; choice?: string | null; optionIndex?: number | null; rationale?: string | null; commandId: string }
export interface OwnerOverrideInput extends OwnerAnswerInput { expectedDecisionId: string; rationale: string }

const HUMAN: DecisionParty = { kind: 'human', session: null, group: null, profile: null }
const ANSWER_FIELDS = ['cardId', 'choice', 'optionIndex', 'rationale'] as const
const OVERRIDE_FIELDS = ['cardId', 'expectedDecisionId', 'choice', 'optionIndex', 'rationale'] as const
const QUESTION_STATES = new Set(['queued', 'awaiting-request'])

function human(caller: DecisionCaller, verb: string) {
  if (caller.kind !== 'human') throw new DecisionRefusal('forbidden', `Only the owner ${verb}s a decision, from the Plans view; no agent tool can.`)
  return caller.team
}

function commandOf(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new DecisionRefusal('invalid', 'This action needs a stable command id so a resend replays instead of repeating.')
  return id
}

const trimmed = (value: string | null | undefined) => value?.trim() || null

/** A recorded command: the same payload returns its decision; another is refused naming the first differing field. */
function replay(service: DecisionService, teamId: string, planId: string, commandId: string, payload: Record<string, unknown>, fields: readonly string[]): DecisionOutcome | null {
  const prior = service.deps.decisions.decisionByCommand(teamId, planId, commandId)
  if (!prior) return null
  const field = payloadDiff(prior.payload, payload, fields)
  if (field) throw new DecisionRefusal('replay-mismatch', `command_id ${commandId} was already used with a different ${field}; decision ${prior.decision.id} stands and nothing was written.`)
  return { card: service.deps.decisions.card(teamId, prior.decision.cardId)!, decision: prior.decision, replayed: true, message: null }
}

function cardOf(service: DecisionService, teamId: string, planId: string, cardId: string): DecisionCard {
  const card = service.deps.decisions.card(teamId, String(cardId ?? ''))
  if (!card || card.planId !== planId) throw new DecisionRefusal('not-found', `Decision card not found on plan ${planId}: ${cardId}`)
  return card
}

/** D6 step 5: in the question's thread, else direct to the asker, else to the asker's group, else no mail. */
async function answerMail(service: DecisionService, caller: DecisionCaller & { kind: 'human' }, card: DecisionCard, body: string): Promise<PreparedMail | null> {
  const task = card.taskId ? { task_id: card.taskId } : {}
  const tags = ['decision-answer']
  if (card.messageId) return service.deps.mailbox.prepareReply(caller, { message_id: card.messageId, body, tags, ...task }, { answer: true })
  const asker = service.deps.getSession(card.askedBy.session)
  if (asker && !asker.contextExhausted) return service.deps.mailbox.prepareSend(caller, { to_kind: 'session', to_id: asker.sessionId, body, tags, ...task })
  const group = card.askedBy.group
  const catalog = loadGroupCatalog({ groupsRoot: caller.team.groupsRoot, ...(service.deps.homeDir ? { homeDir: service.deps.homeDir } : {}) })
  if (group && catalog.groups.has(group)) return service.deps.mailbox.prepareSend(caller, { to_kind: 'group', to_id: group, body, tags, ...task })
  return null
}

export async function answerAsOwner(service: DecisionService, caller: DecisionCaller, input: OwnerAnswerInput): Promise<DecisionOutcome> {
  const team = human(caller, 'answer')
  const commandId = commandOf(input.commandId)
  const { decisions, mailbox } = service.deps
  const plan = teamPlan(service.deps.plans, team.teamId, String(input.planId ?? ''))
  const payload = { cardId: input.cardId, choice: trimmed(input.choice), optionIndex: input.optionIndex ?? null, rationale: trimmed(input.rationale) }
  const prior = replay(service, team.teamId, plan.id, commandId, payload, ANSWER_FIELDS)
  if (prior) return prior
  const card = cardOf(service, team.teamId, plan.id, input.cardId)
  const { choice, optionIndex } = resolveChoice(card.options, { choice: input.choice, option_index: input.optionIndex })
  const rationale = rationaleOf(input.rationale, false)
  const first = decisions.decisionsOfCard(team.teamId, card.id)[0]
  if (first) service.refuseDecided(card, first)
  const id = `decision-${crypto.randomUUID()}`
  const prepared = await answerMail(service, caller as DecisionCaller & { kind: 'human' }, card, answerBody(card, { id, choice, rationale, decidedBy: HUMAN } as PlanDecision))
  try {
    return await service.commitDecision(prepared, card, () => decisions.insertDecision({
      id, cardId: card.id, planId: plan.id, teamId: team.teamId, seq: 1, kind: 'answer', choice, optionIndex, rationale, decidedBy: HUMAN, affected: card.taskId ? [card.taskId] : [], commandId, payload,
    }), () => {
      const question = card.messageId ? mailbox.store.get(card.messageId) : null
      if (question && QUESTION_STATES.has(question.state)) mailbox.store.cancel(question.id, { kind: 'human' }, 'answered by the owner')
    })
  } catch (error) {
    if (error instanceof DecisionConflict && error.kind === 'command-replay') return replay(service, team.teamId, plan.id, commandId, payload, ANSWER_FIELDS)!
    if (error instanceof DecisionConflict && error.kind === 'card-decided') service.refuseDecided(card, error.decision)
    throw error
  }
}

export async function overrideAsOwner(service: DecisionService, caller: DecisionCaller, input: OwnerOverrideInput): Promise<DecisionOutcome & { fixTaskId: string | null }> {
  const team = human(caller, 'override')
  const commandId = commandOf(input.commandId)
  const { decisions, plans } = service.deps
  const plan = teamPlan(plans, team.teamId, String(input.planId ?? ''))
  const payload = { cardId: input.cardId, expectedDecisionId: input.expectedDecisionId ?? null, choice: trimmed(input.choice), optionIndex: input.optionIndex ?? null, rationale: trimmed(input.rationale) }
  const prior = replay(service, team.teamId, plan.id, commandId, payload, OVERRIDE_FIELDS)
  if (prior) return { ...prior, fixTaskId: decisions.fixTaskBySource(team.teamId, 'override', prior.decision.id)?.taskId ?? null }
  const card = cardOf(service, team.teamId, plan.id, input.cardId)
  const current = decisions.decisionsOfCard(team.teamId, card.id).at(-1)
  if (!current) throw new DecisionRefusal('state', `Card ${card.id} is open: answer it instead.`)
  if (current.id !== input.expectedDecisionId) {
    throw new DecisionRefusal('stale', `Card ${card.id}'s current decision is ${current.id} (${current.choice}), not ${input.expectedDecisionId}; reopen the card to read it, then override that one.`)
  }
  const rationale = rationaleOf(input.rationale, true)!
  const { choice, optionIndex } = resolveChoice(card.options, { choice: input.choice, option_index: input.optionIndex })
  if (plan.lifecycle === 'cancelled') throw new DecisionRefusal('state', `Plan ${plan.id} is cancelled: reopen the plan first.`)
  const id = `decision-${crypto.randomUUID()}`
  const fix = await prepareOverrideFix(service.deps, { team, plan, approved: plans.approvedRevision(plan.id), card, superseded: current, override: { id, choice, rationale } })
  const write = () => decisions.atomically(() => {
    const decision = decisions.insertDecision({
      id, cardId: card.id, planId: plan.id, teamId: team.teamId, seq: current.seq + 1, kind: 'override', choice, optionIndex, rationale,
      decidedBy: HUMAN, affected: current.affected, commandId, payload,
    })
    return { decision, fixTaskId: fix.commit().taskId }
  })
  let written: { decision: PlanDecision; fixTaskId: string } | null = null
  try {
    if (plan.lifecycle === 'completed') {
      const outcome = service.deps.planService.reopenWithin({ kind: 'human', team }, { planId: plan.id, commandId: `override:${commandId}:reopen` }, () => { written = write() })
      if (!outcome.ok) throw new DecisionRefusal('state', outcome.message)
    } else {
      written = write()
    }
  } catch (error) {
    if (error instanceof DecisionConflict && error.kind === 'command-replay') {
      const again = replay(service, team.teamId, plan.id, commandId, payload, OVERRIDE_FIELDS)!
      return { ...again, fixTaskId: decisions.fixTaskBySource(team.teamId, 'override', again.decision.id)?.taskId ?? null }
    }
    if (error instanceof DecisionConflict && error.kind === 'card-decided') {
      const winner = error.decision
      throw new DecisionRefusal('stale', `Card ${card.id} was overridden meanwhile${winner ? ` by ${winner.id} (${winner.choice})` : ''}; nothing was written.`)
    }
    throw error
  }
  if (!written) throw new DecisionRefusal('state', `The reopen of plan ${plan.id} replayed without writing the override; nothing was written.`)
  const { decision, fixTaskId } = written as { decision: PlanDecision; fixTaskId: string }
  service.deps.onChange?.(plan.id)
  return { card, decision, replayed: false, message: null, fixTaskId }
}
