// The Audit tab's subscriptions and its one human command
// (execution-safety-recovery D9, D10). Like every human team view, each
// request names the team's directory (`teamPath`); the shared team-scope
// resolver turns it into the team that scopes the whole read, so an unknown
// path and another team's call id are refused with no data. A page request
// answers that page; every committed call, outcome, or acknowledgement of a
// subscribed team sends `team-audit-changed`, and the client re-requests its
// first page — replace semantics, keeping the client trivial. Acknowledge
// runs through OutboundService as the human caller; the commits it causes
// reach every subscriber through the service's onCommit.
//
// The boundary is the one `team-task-*` and `strategy-*` human actions
// have: no agent tool surface reads or writes audit records; a local
// process speaking the UI protocol is trusted like the browser.
import type { ClientMessage } from '../../shared/types'
import type { OutboundAuditFilters } from '../../shared/outbound'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

type AuditClientMessage = Extract<ClientMessage, { type: `team-audit-${string}` }>

interface Subscription {
  teamId: string
  filters: OutboundAuditFilters
}

/** The filters a request carries, narrowed to the store's shape. */
const filtersOf = (message: Extract<AuditClientMessage, { filters: OutboundAuditFilters }>): OutboundAuditFilters => ({
  ...(message.filters.verdict !== undefined ? { verdict: message.filters.verdict } : {}),
  ...(message.filters.rule !== undefined ? { rule: message.filters.rule } : {}),
  ...(message.filters.sessionId !== undefined ? { sessionId: message.filters.sessionId } : {}),
  ...(message.filters.from !== undefined ? { from: message.filters.from } : {}),
  ...(message.filters.to !== undefined ? { to: message.filters.to } : {}),
})

export class OutboundConnections {
  /** Per connection: each open view's `teamPath`, its team, and its filters. */
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest open/close per connection and teamPath, so a close beats a slow open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  /** A committed call, outcome, or acknowledgement of the team (D9). */
  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId === teamId) {
          connection.send({ type: 'team-audit-changed', teamPath, teamId })
        }
      }
    }
  }

  async handle(connection: ChatConnection, message: AuditClientMessage) {
    if (message.type === 'team-audit-acknowledge') return this.acknowledge(connection, message)
    const { teamPath } = message
    const target = `${teamPath}\0page`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-audit-close') {
      this.subscriptions.get(connection)?.delete(teamPath)
      this.pending.get(connection)?.delete(target)
      return
    }
    const { requestId } = message
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const service = this.manager.outboundAudit
    if (message.type === 'team-audit-more') {
      connection.send({
        type: 'team-audit-page', teamPath, teamId: team.teamId, requestId,
        page: service.page(team.teamId, filtersOf(message), message.cursor),
      })
      return
    }
    // team-audit-open: (re)subscribe with the request's filters, then answer.
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    views.set(teamPath, { teamId: team.teamId, filters: filtersOf(message) })
    connection.send({
      type: 'team-audit-page', teamPath, teamId: team.teamId, requestId,
      page: service.page(team.teamId, filtersOf(message)),
    })
  }

  /** The one edit (D10): acknowledge as the human caller. */
  private async acknowledge(connection: ChatConnection, message: Extract<AuditClientMessage, { type: 'team-audit-acknowledge' }>) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-audit-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const outcome = await this.manager.outboundAudit.acknowledge(
      { kind: 'human', team },
      {
        callId: message.callId, commandId: message.commandId,
        ...(message.note !== undefined ? { note: message.note } : {}),
      },
    )
    if (!outcome.ok) answer({ error: outcome.message })
    else answer(outcome.replayed ? { replayed: true } : {})
  }
}
