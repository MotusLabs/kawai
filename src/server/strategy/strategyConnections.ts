// Strategy subscriptions and human strategy actions (product-strategy
// 3.1/5.1). Like the task view, every request names the team's directory
// (`teamPath`, team-workspace-pages D1); its resolved team scopes what may be
// seen or changed, and an unknown path is refused. Snapshots are
// authoritative and re-sent whole on every committed change, so a
// reconnecting client needs no deltas. Human actions run through
// StrategyService as the human caller and answer with `strategy-result`;
// the changes they cause reach every subscriber. The owner's impact
// decisions and assessment requests (strategy-revision-impact D9) go the same
// way through ImpactService, and every detail carries the composed impact.
//
// Draft B boundary (design D3b, ruled 2026-10-13): the forged-WS-client
// vector is explicitly accepted, exactly as for `team-task-*` — human
// actions are trusted from the UI connection. The guarantee the
// spec carries is that no agent tool surface can approve, publish, or
// withdraw; the nonce assurance step (Draft A) is documented, not built.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

type StrategyClientMessage = Extract<ClientMessage, { type: `strategy-${string}` }>

interface Subscription {
  teamId: string
}

export class StrategyConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest open/close per connection and team path; only a later one supersedes a pending open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId === teamId) this.send(connection, teamPath, subscription)
      }
    }
  }

  private send(connection: ChatConnection, teamPath: string, subscription: Subscription) {
    const strategy = this.manager.strategies.store.forTeam(subscription.teamId)
    connection.send({ type: 'strategy-snapshot', teamPath, teamId: subscription.teamId, strategy })
    if (!strategy) return
    // Impact (strategy-revision-impact D9) is composed beside the stored detail, never part of it.
    const impact = this.manager.impact.detail(subscription.teamId)
    connection.send({ type: 'strategy-detail', teamPath, teamId: subscription.teamId, detail: this.manager.strategies.store.detail(strategy.id)!, impact })
  }

  async handle(connection: ChatConnection, message: StrategyClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    const { teamPath } = message
    const target = `${teamPath}\0strategy`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'strategy-close') {
      this.subscriptions.get(connection)?.delete(teamPath)
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    views.set(teamPath, { teamId: team.teamId })
    this.send(connection, teamPath, { teamId: team.teamId })
  }

  /** A human strategy action, as the human caller for the addressed team. */
  private async act(connection: ChatConnection, message: Extract<StrategyClientMessage, { requestId: string }>) {
    const { teamPath, requestId } = message
    const team = await this.manager.teamScopes.resolve(teamPath)
    const fail = (error: unknown) => connection.send({
      type: 'strategy-result', teamPath, requestId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!team) {
      fail(unknownTeamError(teamPath))
      return
    }
    const caller = { kind: 'human' as const, team }
    const strategies = this.manager.strategies
    try {
      switch (message.type) {
        case 'strategy-save-draft': {
          const outcome = await strategies.saveDraft(caller, {
            content: message.content,
            ...(message.productId !== undefined ? { product_id: message.productId } : {}),
            ...(message.title !== undefined ? { title: message.title } : {}),
            ...(message.draftId !== undefined ? { draft_id: message.draftId } : {}),
            ...(message.impactProposal !== undefined ? { impact_proposal: message.impactProposal } : {}),
            ...(message.expectedBaseRevision !== undefined ? { expected_base_revision: message.expectedBaseRevision } : {}),
            ...(message.expectedDraftHash !== undefined ? { expected_draft_hash: message.expectedDraftHash } : {}),
          })
          if (!outcome.ok) {
            // A CAS refusal keeps the caller's text client-side; the stored
            // draft rides along for reconciliation (S12).
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message, conflict: outcome.stored })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId, draft: outcome.draft })
          return
        }
        case 'strategy-submit': {
          const outcome = await strategies.submitForReview(caller, message.draftId !== undefined ? { draft_id: message.draftId } : {})
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId, revision: outcome.revision })
          return
        }
        case 'strategy-approve': {
          const outcome = await strategies.approve(caller, {
            revision: message.revision,
            content_hash: message.contentHash,
            command_id: message.commandId,
            expected_current_revision: message.expectedCurrentRevision,
            ...(message.approvalScope !== undefined ? { approval_scope: message.approvalScope } : {}),
            ...(message.openQuestions !== undefined ? { open_questions: message.openQuestions } : {}),
          })
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId })
          return
        }
        case 'strategy-impact-decide': {
          const outcome = await this.manager.impact.decide(caller, {
            reviewId: message.reviewId, planId: message.planId, disposition: message.disposition, rationale: message.rationale,
            expectedDecisionId: message.expectedDecisionId, commandId: message.commandId,
            ...(message.proposalId !== undefined ? { proposalId: message.proposalId } : {}),
          })
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId, decision: outcome.decision, replayed: outcome.replayed })
          return
        }
        case 'strategy-impact-request': {
          const outcome = await this.manager.impact.requestAssessment(caller, { reviewId: message.reviewId, group: message.group, commandId: message.commandId })
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId, messageId: outcome.messageId, replayed: outcome.replayed })
          return
        }
        case 'strategy-withdraw': {
          const outcome = await strategies.withdraw(caller, {
            ...(message.revision !== undefined ? { revision: message.revision } : {}),
            ...(message.draftId !== undefined ? { draft_id: message.draftId } : {}),
            command_id: message.commandId,
          })
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', teamPath, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', teamPath, requestId })
          return
        }
      }
    } catch (error) {
      fail(error)
    }
  }
}
