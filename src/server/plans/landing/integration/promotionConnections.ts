// The human promotion commands (integration-candidates D9, D13): the Promote
// dialog's preview, Promote, and Cancel over the chat WebSocket, answered by
// `team-plan-result` with `promotionPreview` or `promotion`, or `error` naming
// every failing entry. Like every plan view, each request names the team's
// directory (`teamPath`) through the shared team-scope resolver; an unknown
// path and another team's ids are refused with no data. The commands run
// through PromotionService as the human caller — no agent tool promotes or
// cancels — and the writes they cause reach plan subscribers through the
// integration store's change notices.
import type { ClientMessage } from '../../../../shared/types'
import { unknownTeamError } from '../../../../shared/team'
import type { ChatSessionManager } from '../../../chat/ChatSessionManager'
import type { ChatConnection } from '../../../chat/ChatConnections'
import type { PromotionRow } from './integrationStore'

export type PromotionClientMessage = Extract<ClientMessage, { type: 'team-plan-promotion-preview' | 'team-plan-promote' | 'team-plan-promotion-cancel' }>

export const PROMOTION_MESSAGE_TYPES: ReadonlySet<string> = new Set(['team-plan-promotion-preview', 'team-plan-promote', 'team-plan-promotion-cancel'])

const summary = (promotion: PromotionRow) => ({
  id: promotion.id, number: promotion.number, promotionBranch: promotion.promotionBranch, state: promotion.state, outcome: promotion.outcome,
})

export class PromotionConnections {
  constructor(private readonly manager: ChatSessionManager) {}

  async handle(connection: ChatConnection, message: PromotionClientMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const caller = { kind: 'human' as const, team }
    const promotions = this.manager.promotions
    try {
      switch (message.type) {
        case 'team-plan-promotion-preview': {
          const outcome = await promotions.preview(caller, { planId: message.planId, branch: message.branch })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason })
            return
          }
          answer({ promotionPreview: outcome.preview })
          return
        }
        case 'team-plan-promote': {
          const outcome = await promotions.promote(caller, {
            planId: message.planId, branch: message.branch, fromSha: message.fromSha, commandId: message.commandId,
          })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
            return
          }
          answer({ promotion: summary(outcome.promotion), replayed: outcome.replayed })
          return
        }
        case 'team-plan-promotion-cancel': {
          const outcome = await promotions.cancel(caller, { promotionId: message.promotionId, reason: message.reason, commandId: message.commandId })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
            return
          }
          answer({ promotion: summary(outcome.promotion), replayed: outcome.replayed })
          return
        }
      }
    } catch (error) {
      answer({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
