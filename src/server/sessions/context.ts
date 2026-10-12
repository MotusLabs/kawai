// Shared dependency context for the session operation modules
// (kill/rename/hibernate/wake/move-to-history). Constructed once per server
// boot in the composition root and passed as the first argument of every
// exported handler; leaf utilities (logger, config, validators) stay direct
// module imports (split-server-index design D3).
import type { ServerWebSocket } from 'bun'
import type { SessionRegistry } from '../SessionRegistry'
import type { SessionManager } from '../SessionManager'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ServerMessage } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'
import type { initDatabase } from '../db'

type SessionDatabase = ReturnType<typeof initDatabase>

/** Result of one remote ssh/tmux invocation (see runRemoteTmux/runRemoteSsh). */
export interface RemoteCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SessionOpsContext {
  registry: SessionRegistry
  db: SessionDatabase
  sessionManager: SessionManager
  refresh: SessionRefreshLoop
  chatSessionManager: ChatSessionManager
  broadcast: (message: ServerMessage) => void
  send: (ws: ServerWebSocket<WSData>, message: ServerMessage) => void
  /** Remote tmux control-plane call (RemoteSessionService until it lands). */
  runRemoteTmux: (host: string, args: string[]) => Promise<RemoteCommandResult>
  /** Optimistic remote-rename overrides; shared with the remote merge. */
  remoteSessionNameOverrides: Map<string, { name: string; setAt: number }>
  /** Optimistic remote-kill tombstones; shared with the remote merge. */
  remoteSessionTombstones: Map<string, number>
}
