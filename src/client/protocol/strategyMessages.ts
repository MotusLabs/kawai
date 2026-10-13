// Store dispatches for product strategy snapshots, details, and action results.
import { useStrategyStore } from '../stores/strategyStore'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type StrategyMessage = Extract<ServerMessage, { type: `strategy-${string}` }>

export function handleStrategyMessage(message: StrategyMessage, _deps: MessageRouterDeps): void {
  const strategy = useStrategyStore.getState()
  switch (message.type) {
    case 'strategy-snapshot': strategy.applySnapshot(message); return
    case 'strategy-detail': strategy.applyDetail(message); return
    case 'strategy-result': strategy.applyResult(message); return
  }
}
