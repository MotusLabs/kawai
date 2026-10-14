// Store dispatches for product strategy snapshots, details, and action results.
import { useStrategyStore } from '../stores/strategyStore'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type StrategyMessage = Extract<ServerMessage, { type: `strategy-${string}` }>

export function handleStrategyMessage(message: StrategyMessage, _deps: MessageRouterDeps): void {
  const strategy = useStrategyStore.getState()
  // A reply for a moved team key goes to the view's new key (teamKeyAliases).
  const routed = { ...message, teamPath: routedTeamPath(message.teamPath, strategy.views) }
  switch (routed.type) {
    case 'strategy-snapshot': strategy.applySnapshot(routed); return
    case 'strategy-detail': strategy.applyDetail(routed); return
    case 'strategy-result': strategy.applyResult(routed); return
  }
}
