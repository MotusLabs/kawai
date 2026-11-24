// The owner's decision commands (plan-supervision design D15): answering a
// card addressed to the owner (`team-plan-decide`) and overriding a decided
// card (`team-plan-override`) over the chat WebSocket, answered by
// `team-plan-result` with `decision`. Like every plan view, each request
// names the team's directory (`teamPath`) through the shared team-scope
// resolver; an unknown path and another team's plan or card are refused with
// no data. Both run through DecisionService as the human caller — no agent
// tool answers an owner card or overrides — and the plan's detail reaches its
// subscribers through the decision write's announce.
import type { ClientMessage } from '../../../shared/types'
import { z } from 'zod'
import { unknownTeamError } from '../../../shared/team'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import { DecisionRefusal, RATIONALE_MAX } from './decisionInputs'
import { HANDOFF_ID } from './decisionPublicationAsk'

export const DECISION_COMMAND_TYPES = ['team-plan-decide', 'team-plan-override', 'team-plan-publication-review', 'team-plan-approve-publication'] as const
export type DecisionClientMessage = Extract<ClientMessage, { type: (typeof DECISION_COMMAND_TYPES)[number] }>

export const isDecisionCommand = (message: { type: string }): message is DecisionClientMessage =>
  (DECISION_COMMAND_TYPES as readonly string[]).includes(message.type)

const ADDRESS = {
  teamPath: z.string().refine(value => !!value.trim()),
  requestId: z.string().refine(value => !!value.trim()),
  planId: z.string().regex(/^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  cardId: z.string().regex(/^card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
}
const REVIEW = z.strictObject({ ...ADDRESS, type: z.literal('team-plan-publication-review') })
const APPROVE = z.strictObject({
  ...ADDRESS, type: z.literal('team-plan-approve-publication'),
  expectedHandoffId: z.string().regex(HANDOFF_ID),
  expectedBindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  rationale: z.string().trim().max(RATIONALE_MAX).nullable().optional(),
  commandId: z.string().trim().min(1),
})

export async function handleDecisionCommand(manager: ChatSessionManager, connection: ChatConnection, message: DecisionClientMessage) {
  const { teamPath, requestId } = message
  const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
  const publicationCommand = message.type === 'team-plan-publication-review' || message.type === 'team-plan-approve-publication'
  if (publicationCommand) {
    const parsed = (message.type === 'team-plan-publication-review' ? REVIEW : APPROVE).safeParse(message)
    if (!parsed.success) {
      answer({ error: parsed.error.issues.map(issue => issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message).join('; '), reason: 'invalid' })
      return
    }
  }
  const team = await manager.teamScopes.resolve(teamPath)
  if (!team) {
    answer({ error: unknownTeamError(teamPath), ...(publicationCommand ? { reason: 'not-found' } : {}) })
    return
  }
  const decisions = manager.decisions
  if (!decisions) {
    answer({ error: 'Plan decisions are not available on this server.', ...(publicationCommand ? { reason: 'state' } : {}) })
    return
  }
  const caller = { kind: 'human' as const, team }
  try {
    if (message.type === 'team-plan-publication-review') {
      answer({ publicationReview: decisions.reviewPublication(caller, message) })
      return
    }
    if (message.type === 'team-plan-approve-publication') {
      const outcome = await decisions.approvePublication(caller, message)
      answer({ decision: { card: outcome.card, decision: outcome.decision }, publication: outcome.publication, replayed: outcome.replayed })
      return
    }
    const common = {
      planId: message.planId, cardId: message.cardId, commandId: message.commandId,
      ...(message.choice !== undefined ? { choice: message.choice } : {}),
      ...(message.optionIndex !== undefined ? { optionIndex: message.optionIndex } : {}),
    }
    const outcome = message.type === 'team-plan-decide'
      ? await decisions.answer(caller, { ...common, ...(message.rationale !== undefined ? { rationale: message.rationale } : {}) })
      : await decisions.override(caller, { ...common, expectedDecisionId: message.expectedDecisionId, rationale: message.rationale })
    answer({
      decision: {
        card: outcome.card, decision: outcome.decision,
        ...('fixTaskId' in outcome ? { fixTaskId: outcome.fixTaskId } : {}),
      },
      replayed: outcome.replayed,
    })
  } catch (error) {
    if (error instanceof DecisionRefusal) answer({ error: error.message, reason: error.reason })
    else answer({ error: error instanceof Error ? error.message : String(error), ...(publicationCommand ? { reason: 'state' } : {}) })
  }
}
