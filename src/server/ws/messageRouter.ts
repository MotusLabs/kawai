// WebSocket message router: parses each client frame and dispatches it — chat
// and team frames to ChatConnections, session create (chat, remote, local
// tmux window) inline, session ops to sessions/, terminal frames to
// ws/terminalAttach, copy-mode probes to ws/copyMode, and worktree creation
// to git/ with a scoped workspace refresh afterwards. The terminal-attach
// case bumps `terminalAttachSeq` before launching the attach (race guard,
// moved verbatim from index.ts).
import fsSync from 'node:fs'
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import { resolveProjectPath } from '../paths'
import { composeAutoStartCommand } from '../applyCommand'
import { stampLocalSession } from '../sessionStamp'
import { profileRequestError } from '../routes/claudeProfiles'
import { parseApprovalPolicy } from '../chat/approvalPolicy'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection, ChatConnections } from '../chat/ChatConnections'
import type { ClientMessage } from '../../shared/types'
import {
  parseCreateChangeWorktreePayload,
  parseCreateWorktreePayload,
} from '../../shared/workspaceValidation'
import { deepestPathMatch } from '../../shared/workspace'
import { canonicalizePath } from '../git/repositoryResolution'
import { createWorktree } from '../git/createWorktree'
import { createChangeWorktree } from '../git/createChangeWorktree'
import type { WorkspaceCoordinator } from '../workspace/workspaceCoordinator'
import type { SessionManager } from '../SessionManager'
import type { SessionRegistry } from '../SessionRegistry'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'
import type { RemoteSessionService } from '../remote/RemoteSessionService'
import { handleKill } from '../sessions/kill'
import { handleRename } from '../sessions/rename'
import { handleSessionHibernate } from '../sessions/hibernate'
import { handleMoveToHistory } from '../sessions/moveToHistory'
import { handleSessionWake } from '../sessions/wake'
import type { SessionOpsContext } from '../sessions/context'
import type { ConnectionHub } from './ConnectionHub'
import { fireAndForget } from './ConnectionHub'
import { handleCancelCopyMode, handleCheckCopyMode, type CopyModeContext } from './copyMode'
import {
  attachTerminalPersistent,
  detachTerminalPersistent,
  handleTerminalInputPersistent,
  handleTerminalPastePersistent,
  handleTerminalResizePersistent,
  type TerminalAttachContext,
} from './terminalAttach'
import type { WSData } from './wsTypes'

export interface MessageRouterContext {
  hub: ConnectionHub
  registry: SessionRegistry
  sessionManager: SessionManager
  refresh: SessionRefreshLoop
  chatSessionManager: ChatSessionManager
  chatConnections: ChatConnections
  /** The socket's ChatConnection peer (created on first use). */
  chatPeer: (ws: ServerWebSocket<WSData>) => ChatConnection
  remote: RemoteSessionService
  workspaceCoordinator: WorkspaceCoordinator
  sessionOps: SessionOpsContext
  terminal: TerminalAttachContext
  copyMode: CopyModeContext
}

/**
 * Actionable error for a project path that disappeared between discovery
 * and submission. Names the owning worktree when one is known from the
 * latest snapshot so the user can tell which group went stale.
 */
function staleProjectPathError(ctx: MessageRouterContext, missingPath: string): string {
  const { workspaceCoordinator } = ctx
  const worktreePaths =
    workspaceCoordinator.getSnapshot()?.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => worktree.path)
    ) ?? []
  const owner = deepestPathMatch(canonicalizePath(missingPath), worktreePaths)
  if (owner) {
    return `Worktree no longer exists: ${owner}. It may have been removed outside Agentboard; workspace metadata is refreshing.`
  }
  return `Project path does not exist: ${missingPath}`
}

async function handleCreateWorktree(
  ctx: MessageRouterContext,
  ws: ServerWebSocket<WSData>,
  payload: { repositoryId: string; branch: string; destination: string; launchSession?: boolean }
): Promise<void> {
  const { send } = ctx.hub
  const { workspaceCoordinator } = ctx
  // Validated, non-forced git worktree add (§8.3). Refresh + broadcast of the
  // affected repository and launch routing happen in §8.4.
  const result = await createWorktree({
    repositoryId: payload.repositoryId,
    branch: payload.branch,
    destination: payload.destination,
  })
  send(ws, { type: 'workspace-operation-result', result })
  fireAndForget(
    workspaceCoordinator.requestRefresh(result.ok ? result.path : payload.destination),
    'workspaceRefreshAfterOperation'
  )
}

async function handleCreateChangeWorktree(
  ctx: MessageRouterContext,
  ws: ServerWebSocket<WSData>,
  payload: { repositoryId: string; change: string }
): Promise<void> {
  const { send } = ctx.hub
  const { workspaceCoordinator } = ctx
  // Seeded creation (§7.2) with immediate revalidation inside the operation
  // (§7.3): repository identity, destination nonexistence, and branch
  // assignment are re-read from Git right before the non-forced
  // `git worktree add`. The snapshot refreshes after every result — success
  // or failure — so the navigator never shows stale sections.
  const result = await createChangeWorktree({
    repositoryId: payload.repositoryId,
    change: payload.change,
  })
  send(ws, { type: 'workspace-operation-result', result })
  fireAndForget(
    workspaceCoordinator.requestRefresh(result.ok ? result.path : payload.repositoryId),
    'workspaceRefreshAfterChangeOperation'
  )
}

export function handleMessage(
  ctx: MessageRouterContext,
  ws: ServerWebSocket<WSData>,
  rawMessage: string | BufferSource
) {
  const { send } = ctx.hub
  const {
    registry,
    sessionManager,
    refresh,
    chatSessionManager,
    chatConnections,
    chatPeer,
    remote,
    workspaceCoordinator,
    sessionOps,
    terminal,
    copyMode,
  } = ctx
  const text =
    typeof rawMessage === 'string'
      ? rawMessage
      : new TextDecoder().decode(rawMessage)

  let message: ClientMessage
  try {
    message = JSON.parse(text) as ClientMessage
  } catch {
    send(ws, { type: 'error', message: 'Invalid message payload' })
    return
  }

  switch (message.type) {
    case 'chat-attach':
    case 'chat-detach':
    case 'chat-send':
    case 'chat-interrupt':
    case 'chat-archive':
    case 'chat-restore':
    case 'chat-approval':
    case 'chat-answer':
    case 'chat-set-approval-policy':
    case 'chat-debug-open':
    case 'chat-debug-page':
    case 'chat-debug-close':
    case 'team-mailbox-open':
    case 'team-mailbox-close':
    case 'team-mailbox-cancel':
    case 'team-mailbox-retry':
    case 'team-mailbox-discard':
    case 'team-mailbox-reload-rules':
    case 'team-mailbox-hand-off':
    case 'team-tasks-open':
    case 'team-tasks-close':
    case 'team-task-open':
    case 'team-task-close':
    case 'team-task-create':
    case 'team-task-amend':
    case 'team-task-note':
    case 'team-task-status':
    case 'chat-worker-transcript':
    case 'chat-task-output':
    case 'chat-task-stop':
      fireAndForget(chatConnections.handle(chatPeer(ws), message), 'chatMessage')
      return
    case 'ping':
      send(ws, message.seq != null ? { type: 'pong', seq: message.seq } : { type: 'pong' })
      return
    case 'session-refresh':
      refresh.refreshSessions()
      return
    case 'session-create':
      if (profileRequestError(message)) {
        send(ws, { type: 'error', message: profileRequestError(message)! })
        return
      }
      if (message.kind === 'chat') {
        // parseApprovalPolicy sanitizes the wire value: absent or unknown
        // reads as manual, so older clients are unchanged (design D3).
        const input = {
          projectPath: message.projectPath,
          name: message.name,
          ...(typeof message.cloneFromSessionId === 'string' ? { cloneFromSessionId: message.cloneFromSessionId } : {}),
          claudeProfileId: message.claudeProfileId,
          approvalPolicy: parseApprovalPolicy(message.approvalPolicy),
          ...(typeof message.groupId === 'string' && message.groupId.trim()
            ? { groupId: message.groupId.trim() }
            : {}),
        }
        fireAndForget(chatSessionManager.createAvailableSession(input).then(result => {
          if (result.ok) send(ws, { type: 'session-created', session: result.session })
          else send(ws, { type: 'error', message: result.error })
        }), 'createChatSession')
        return
      }
      if (message.host) {
        fireAndForget(
          remote.handleCreate(
            message.host,
            message.projectPath,
            message.name,
            message.command,
            message.autoStartAgent,
            message.autoStartChange,
            ws
          ),
          'handleRemoteCreate'
        )
      } else {
        try {
          // Compose the selected agent's apply prompt onto the start command
          // as a launch argument; no prompt when agent or change is absent.
          const startCommand = composeAutoStartCommand(
            message.command,
            message.autoStartAgent,
            message.autoStartChange
          )
          if (message.autoStartAgent && startCommand === message.command) {
            logger.info('auto_start_not_composed', {
              reason: 'unrecognized_agent_or_invalid_change',
            })
          }
          const created = stampLocalSession(sessionManager.createWindow(
            message.projectPath,
            message.name,
            startCommand
          ))
          // Add session to registry immediately so terminal can attach
          refresh.noteOptimisticMutation()
          const currentSessions = registry.getAll()
          registry.replaceSessions([created, ...currentSessions])
          refresh.refreshSessions()
          send(ws, { type: 'session-created', session: created })
        } catch (error) {
          // A directory that vanished between discovery and submission —
          // typically a worktree removed outside Agentboard — gets an
          // actionable, worktree-aware error plus a scoped workspace refresh
          // so the stale group reconciles without a page reload (§7.3).
          const resolvedPath = resolveProjectPath(message.projectPath)
          if (resolvedPath && !fsSync.existsSync(resolvedPath)) {
            send(ws, { type: 'error', message: staleProjectPathError(ctx, resolvedPath) })
            fireAndForget(
              workspaceCoordinator.requestRefresh(resolvedPath),
              'workspaceRefreshMissingPath'
            )
          } else {
            send(ws, {
              type: 'error',
              message:
                error instanceof Error ? error.message : 'Unable to create session',
            })
          }
        }
      }
      return
    case 'session-kill':
      fireAndForget(handleKill(sessionOps, message.sessionId, ws, message.source), 'handleKill')
      return
    case 'session-rename':
      fireAndForget(handleRename(sessionOps, message.sessionId, message.newName, ws), 'handleRename')
      return
	    case 'terminal-attach':
	      ws.data.terminalAttachSeq += 1
	      fireAndForget(attachTerminalPersistent(terminal, ws, message, ws.data.terminalAttachSeq), 'attachTerminalPersistent')
	      return
	    case 'terminal-detach':
	      detachTerminalPersistent(ws, message.sessionId)
	      return
    case 'terminal-input':
      handleTerminalInputPersistent(terminal, ws, message.sessionId, message.data)
      return
    case 'terminal-paste':
      handleTerminalPastePersistent(terminal, ws, message.sessionId, message.data)
      return
    case 'terminal-resize':
      handleTerminalResizePersistent(
        terminal,
        ws,
        message.sessionId,
        message.cols,
        message.rows
      )
      return
    case 'tmux-cancel-copy-mode':
      // Exit tmux copy-mode when user starts typing after scrolling
      fireAndForget(handleCancelCopyMode(copyMode, message.sessionId, ws), 'handleCancelCopyMode')
      return
    case 'tmux-check-copy-mode':
      fireAndForget(handleCheckCopyMode(copyMode, message.sessionId, ws), 'handleCheckCopyMode')
      return
    case 'session-wake':
      fireAndForget(handleSessionWake(sessionOps, message, ws), 'handleSessionWake')
      return
    case 'session-hibernate':
      handleSessionHibernate(sessionOps, message.sessionId, ws)
      return
    case 'session-move-to-history':
      handleMoveToHistory(sessionOps, message.sessionId, ws)
      return
    case 'workspace-refresh':
      fireAndForget(workspaceCoordinator.requestRefresh(message.projectPath), 'workspaceRefresh')
      return
    case 'create-worktree': {
      const payload = parseCreateWorktreePayload(message)
      if (!payload) {
        send(ws, { type: 'error', message: 'Invalid create-worktree payload' })
        return
      }
      fireAndForget(handleCreateWorktree(ctx, ws, payload), 'handleCreateWorktree')
      return
    }
    case 'create-change-worktree': {
      const payload = parseCreateChangeWorktreePayload(message)
      if (!payload) {
        send(ws, { type: 'error', message: 'Invalid create-change-worktree payload' })
        return
      }
      fireAndForget(handleCreateChangeWorktree(ctx, ws, payload), 'handleCreateChangeWorktree')
      return
    }
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}
