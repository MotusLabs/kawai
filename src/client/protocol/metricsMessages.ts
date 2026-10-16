// Store dispatch for process-metrics snapshots (team-process-metrics D5). A
// snapshot for a moved team key goes to the view's new key (teamKeyAliases).
import { useMetricsStore } from '../stores/metricsStore'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'

export function handleMetricsMessage(message: Extract<ServerMessage, { type: 'process-metrics-snapshot' }>): void {
  const metrics = useMetricsStore.getState()
  metrics.applySnapshot({ ...message, teamPath: routedTeamPath(message.teamPath, metrics.views) })
}
