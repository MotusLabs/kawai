// Metrics tab subscriptions over the chat connection (team-process-metrics
// D5). A request names the team's directory (`teamPath`); the shared
// team-scope resolver turns it into the team, and an unknown path is refused
// as `unknown-team` with no data. A subscription holds one window and slice
// per connection and team path: open answers with a snapshot (through the
// shared 30 s read cache, so a tool call in the same moment shares it),
// refresh answers with a fresh computation, close ends it, and `publish`
// re-sends every subscriber of a team after a report or decision commit.
// Nothing here listens to mail: values change only when asked or published.
// The human's proposal commands (D6) — decide, and link/replace/unlink — run
// through the report service as the human for the resolved team, answered by
// `process-proposal-result`; the service's commit hook does the re-send.
import { isMetricWindow, type MetricSlice, type MetricWindow } from '../../shared/processMetrics'
import { REPORTS_IN_SNAPSHOT, type MetricsClientMessage } from '../../shared/metricsMessages'
import { unknownTeamError } from '../../shared/team'
import type { ChatConnection } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { parseSlice } from './metricsTools'

interface Subscription {
  teamId: string
  window: MetricWindow
  slice: MetricSlice | null
}

export class MetricsConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest request per connection and team path; a later one supersedes a pending open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: Pick<ChatSessionManager, 'teamScopes' | 'metrics' | 'reports'>) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  /** A committed report or decision of the team: every subscriber gets a fresh snapshot. */
  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId === teamId) this.send(connection, teamPath, subscription, true)
      }
    }
  }

  private send(connection: ChatConnection, teamPath: string, subscription: Subscription, fresh: boolean) {
    const { teamId, window } = subscription
    const metrics = this.manager.metrics.read(teamId, window, subscription.slice, { fresh })
    const { reports, freshness } = this.manager.reports.list(teamId, REPORTS_IN_SNAPSHOT)
    connection.send({
      type: 'process-metrics-snapshot', teamPath, teamId, window, slice: subscription.slice, computedAt: metrics.computedAt, metrics,
      reports, freshness, unproposed: this.manager.reports.unproposed(teamId, window),
    })
  }

  /** A human proposal command: decide, or link/replace/unlink, by command key. */
  async handleCommand(connection: ChatConnection, message: Extract<MetricsClientMessage, { type: `process-proposal-${string}` }>) {
    const kind: 'decide' | 'link' = message.type === 'process-proposal-decide' ? 'decide' : 'link'
    const base = { type: 'process-proposal-result' as const, teamPath: message.teamPath, commandId: message.commandId, kind }
    const team = await this.manager.teamScopes.resolve(message.teamPath)
    if (!team) {
      connection.send({ ...base, error: unknownTeamError(message.teamPath) })
      return
    }
    try {
      if (message.type === 'process-proposal-decide') {
        const { replay, outcome } = this.manager.reports.decide(team.teamId, message)
        connection.send({ ...base, replayed: replay, decision: outcome })
      } else {
        const { replay, outcome } = this.manager.reports.linkByHuman(team.teamId, message)
        connection.send({ ...base, replayed: replay, link: outcome })
      }
    } catch (error) {
      connection.send({ ...base, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async handle(connection: ChatConnection, message: Extract<MetricsClientMessage, { type: `process-metrics-${string}` }>) {
    const { teamPath } = message
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(teamPath, token)
    this.pending.set(connection, pending)
    if (message.type === 'process-metrics-close') {
      this.subscriptions.get(connection)?.delete(teamPath)
      return
    }
    if (!isMetricWindow(message.window)) {
      connection.send({ type: 'error', message: `Unknown metrics window: ${String(message.window)}` })
      return
    }
    let slice
    try {
      slice = parseSlice(message.slice ?? undefined)
    } catch (error) {
      connection.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(teamPath) !== token) return
    this.pending.get(connection)?.delete(teamPath)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    const subscription = { teamId: team.teamId, window: message.window, slice }
    views.set(teamPath, subscription)
    this.send(connection, teamPath, subscription, message.type === 'process-metrics-refresh')
  }
}
