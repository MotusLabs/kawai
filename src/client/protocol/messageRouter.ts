// The client's WebSocket message router: one dispatcher over the
// ServerMessage union, delegating to the per-concern protocol modules.
// Handlers read stores via getState() and receive only stable refs and
// callbacks (MessageRouterDeps), so the router subscribes once for the
// app's lifetime instead of re-subscribing on selection changes.
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'
import { handleChatMessage } from './chatMessages'
import { handleTeamMessage } from './teamMessages'
import { handleStrategyMessage } from './strategyMessages'
import {
  handleError,
  handleHostStatus,
  handleServerConfig,
  handleTerminalError,
  handleTerminalReady,
  handleUpdateState,
} from './serverMessages'
import {
  handleAgentSessions,
  handleAgentSessionsActive,
  handleKillFailed,
  handleSessionActivated,
  handleSessionCreated,
  handleSessionHibernateResult,
  handleSessionMoveToHistoryResult,
  handleSessionOrphaned,
  handleSessionRemoved,
  handleSessionUpdate,
  handleSessionWakeResult,
  handleSessions,
} from './sessionMessages'
import {
  handleWorkspaceOperationResult,
  handleWorkspaceSnapshot,
} from './workspaceMessages'

export type { MessageRouterDeps } from './types'

export function createMessageRouter(
  deps: MessageRouterDeps
): (message: ServerMessage) => void {
  return (message) => {
    if (message.type.startsWith('chat-')) {
      handleChatMessage(message as Extract<ServerMessage, { type: `chat-${string}` }>, deps)
      return
    }
    if (message.type.startsWith('team-')) {
      handleTeamMessage(message as Extract<ServerMessage, { type: `team-${string}` }>, deps)
      return
    }
    switch (message.type) {
      // Streamed terminal output has its own pipe (useTerminal); ignore it here.
      case 'terminal-output':
        return
      case 'sessions': return handleSessions(message, deps)
      case 'session-update': return handleSessionUpdate(message, deps)
      case 'session-created': return handleSessionCreated(message, deps)
      case 'session-removed': return handleSessionRemoved(message, deps)
      case 'session-orphaned': return handleSessionOrphaned(message, deps)
      case 'session-activated': return handleSessionActivated(message, deps)
      case 'session-wake-result': return handleSessionWakeResult(message, deps)
      case 'session-hibernate-result': return handleSessionHibernateResult(message, deps)
      case 'session-move-to-history-result': return handleSessionMoveToHistoryResult(message, deps)
      case 'kill-failed': return handleKillFailed(message, deps)
      case 'agent-sessions': return handleAgentSessions(message, deps)
      case 'agent-sessions-active': return handleAgentSessionsActive(message, deps)
      case 'workspace-snapshot': return handleWorkspaceSnapshot(message, deps)
      case 'workspace-operation-result': return handleWorkspaceOperationResult(message, deps)
      case 'host-status': return handleHostStatus(message, deps)
      case 'server-config': return handleServerConfig(message, deps)
      case 'update-state': return handleUpdateState(message, deps)
      case 'strategy-snapshot':
      case 'strategy-detail':
      case 'strategy-result': return handleStrategyMessage(message, deps)
      case 'error': return handleError(message, deps)
      case 'terminal-error': return handleTerminalError(message, deps)
      case 'terminal-ready': return handleTerminalReady(message, deps)
    }
  }
}
