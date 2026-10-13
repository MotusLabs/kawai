// Strategy subscriptions and human strategy actions (product-strategy
// 3.1/5.1). Like the task view, every request names a chat session; its
// resolved team scopes what may be seen or changed. Snapshots are
// authoritative and re-sent whole on every committed change, so a
// reconnecting client needs no deltas. Human actions run through
// StrategyService as the human caller and answer with `strategy-result`;
// the changes they cause reach every subscriber.
//
// Draft B boundary (design D3b, ruled 2026-10-13): the forged-WS-client
// vector is explicitly accepted, exactly as for `team-task-*` — human
// actions are trusted from the UI connection's session. The guarantee the
// spec carries is that no agent tool surface can approve, publish, or
// withdraw; the nonce assurance step (Draft A) is documented, not built.
import type { ClientMessage } from '../../shared/types'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

type StrategyClientMessage = Extract<ClientMessage, { type: `strategy-${string}` }>

interface Subscription {
  teamId: string
}

export class StrategyConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest open/close per connection and session; only a later one supersedes a pending open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  publish(teamId: string) {
    for (const [connection, sessions] of this.subscriptions) {
      for (const [sessionId, subscription] of sessions) {
        if (subscription.teamId === teamId) this.send(connection, sessionId, subscription)
      }
    }
  }

  private send(connection: ChatConnection, sessionId: string, subscription: Subscription) {
    const strategy = this.manager.strategies.store.forTeam(subscription.teamId)
    connection.send({ type: 'strategy-snapshot', sessionId, teamId: subscription.teamId, strategy })
    if (strategy) connection.send({ type: 'strategy-detail', sessionId, teamId: subscription.teamId, detail: this.manager.strategies.store.detail(strategy.id)! })
  }

  async handle(connection: ChatConnection, message: StrategyClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    const { sessionId } = message
    const target = `${sessionId}\0strategy`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'strategy-close') {
      this.subscriptions.get(connection)?.delete(sessionId)
      return
    }
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'error', message: 'Chat team is unavailable' })
      return
    }
    const sessions = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, sessions)
    sessions.set(sessionId, { teamId: team.teamId })
    this.send(connection, sessionId, { teamId: team.teamId })
  }

  /** A human strategy action, as the human caller for the session's team. */
  private async act(connection: ChatConnection, message: Extract<StrategyClientMessage, { requestId: string }>) {
    const { sessionId, requestId } = message
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    const fail = (error: unknown) => connection.send({
      type: 'strategy-result', sessionId, requestId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!this.manager.has(sessionId) || !team) {
      fail('Chat team is unavailable')
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
            connection.send({ type: 'strategy-result', sessionId, requestId, error: outcome.message, conflict: outcome.stored })
            return
          }
          connection.send({ type: 'strategy-result', sessionId, requestId, draft: outcome.draft })
          return
        }
        case 'strategy-submit': {
          const outcome = await strategies.submitForReview(caller, message.draftId !== undefined ? { draft_id: message.draftId } : {})
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', sessionId, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', sessionId, requestId, revision: outcome.revision })
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
            connection.send({ type: 'strategy-result', sessionId, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', sessionId, requestId })
          return
        }
        case 'strategy-withdraw': {
          const outcome = await strategies.withdraw(caller, {
            ...(message.revision !== undefined ? { revision: message.revision } : {}),
            ...(message.draftId !== undefined ? { draft_id: message.draftId } : {}),
            command_id: message.commandId,
          })
          if (!outcome.ok) {
            connection.send({ type: 'strategy-result', sessionId, requestId, error: outcome.message })
            return
          }
          connection.send({ type: 'strategy-result', sessionId, requestId })
          return
        }
      }
    } catch (error) {
      fail(error)
    }
  }
}
