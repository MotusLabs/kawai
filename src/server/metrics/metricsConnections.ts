// Metrics tab subscriptions over the chat connection (team-process-metrics
// D5). A request names the team's directory (`teamPath`); the shared
// team-scope resolver turns it into the team, and an unknown path is refused
// as `unknown-team` with no data. A subscription holds one window and slice
// per connection and team path: open answers with a snapshot (through the
// shared 30 s read cache, so a tool call in the same moment shares it),
// refresh answers with a fresh computation, close ends it, and `publish`
// re-sends every subscriber of a team after a report or decision commit.
// Nothing here listens to mail: values change only when asked or published.
import { isMetricWindow, type MetricSlice, type MetricWindow } from '../../shared/processMetrics'
import type { MetricsClientMessage } from '../../shared/metricsMessages'
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

  constructor(private readonly manager: Pick<ChatSessionManager, 'teamScopes' | 'metrics'>) {}

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
    const metrics = this.manager.metrics.read(subscription.teamId, subscription.window, subscription.slice, { fresh })
    connection.send({
      type: 'process-metrics-snapshot', teamPath, teamId: subscription.teamId, window: subscription.window,
      slice: subscription.slice, computedAt: metrics.computedAt, metrics,
    })
  }

  async handle(connection: ChatConnection, message: MetricsClientMessage) {
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
