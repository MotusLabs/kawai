// Store dispatch for process-metrics snapshots (team-process-metrics D5) and
// proposal command results (D6), and reports opened by id. A
// snapshot for a moved team key goes to the view's new key (teamKeyAliases).
import { useMetricsStore } from '../stores/metricsStore'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'

export function handleMetricsMessage(message: Extract<ServerMessage, { type: 'process-metrics-snapshot' | 'process-proposal-result' | 'process-report-detail' }>): void {
  const metrics = useMetricsStore.getState()
  const teamPath = routedTeamPath(message.teamPath, metrics.views)
  if (message.type === 'process-proposal-result') metrics.applyResult({ ...message, teamPath })
  else if (message.type === 'process-report-detail') metrics.applyReport({ ...message, teamPath })
  else metrics.applySnapshot({ ...message, teamPath })
}
