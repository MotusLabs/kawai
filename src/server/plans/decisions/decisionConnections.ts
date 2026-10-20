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
import { unknownTeamError } from '../../../shared/team'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import { DecisionRefusal } from './decisionInputs'

export type DecisionClientMessage = Extract<ClientMessage, { type: 'team-plan-decide' | 'team-plan-override' }>

export const DECISION_COMMAND_TYPES = ['team-plan-decide', 'team-plan-override'] as const

export const isDecisionCommand = (message: { type: string }): message is DecisionClientMessage =>
  (DECISION_COMMAND_TYPES as readonly string[]).includes(message.type)

export async function handleDecisionCommand(manager: ChatSessionManager, connection: ChatConnection, message: DecisionClientMessage) {
  const { teamPath, requestId } = message
  const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
  const team = await manager.teamScopes.resolve(teamPath)
  if (!team) {
    answer({ error: unknownTeamError(teamPath) })
    return
  }
  const decisions = manager.decisions
  if (!decisions) {
    answer({ error: 'Plan decisions are not available on this server.' })
    return
  }
  const caller = { kind: 'human' as const, team }
  const common = {
    planId: message.planId, cardId: message.cardId, commandId: message.commandId,
    ...(message.choice !== undefined ? { choice: message.choice } : {}),
    ...(message.optionIndex !== undefined ? { optionIndex: message.optionIndex } : {}),
  }
  try {
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
    else answer({ error: error instanceof Error ? error.message : String(error) })
  }
}
