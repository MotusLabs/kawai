// History sessions lookback limits (in hours)
export const HISTORY_MAX_AGE_MIN_HOURS = 1
export const HISTORY_MAX_AGE_MAX_HOURS = 168 // 7 days

import type {
  WorkspaceOperationResult,
  WorkspaceSnapshot,
} from './workspace'
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatEvent,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatWireFrame,
} from './chat'

export type {
  ChatActivity,
  ChatActivityPhase,
  ChatEvent,
  ChatQuestion,
  ChatQuestionAnswer,
  ChatPendingRequest,
  ChatRequestOutcome,
  ChatRequestDecidedBy,
  ChatApprovalPolicy,
  ChatApprovalDecision,
  ChatTurnResultSubtype,
  ChatCommand,
  ChatCommandSource,
  ChatCommandState,
  ChatWireDirection,
  ChatWireFrame,
} from './chat'

export type {
  WorkspaceBranch,
  WorkspaceRepository,
  WorkspaceSnapshot,
  WorkspaceWorktree,
  WorktreeOpenSpecState,
  OpenSpecChangeSummary,
  WorkspaceOperationResult,
  WorkspaceErrorCode,
} from './workspace'

export type SessionStatus = 'working' | 'waiting' | 'permission' | 'unknown'

export type SessionSource = 'managed' | 'external'
export type AgentType = 'claude' | 'claude-rp' | 'codex' | 'pi'

/** First-prompt agents offered by the session form's "Start with" selector. */
export type AutoStartAgent = 'claude' | 'codex'
export type ClipboardOfferSource = 'tmux-buffer' | 'osc52'
export type SessionKillSource =
  | 'keyboard_shortcut'
  | 'session_list_context_menu'
  | 'terminal_confirm_modal'
  | 'unknown'
export type TerminalErrorCode =
  | 'ERR_INVALID_WINDOW'
  | 'ERR_SESSION_CREATE_FAILED'
  | 'ERR_START_TIMEOUT'
  | 'ERR_TMUX_ATTACH_FAILED'
  | 'ERR_TMUX_SWITCH_FAILED'
  | 'ERR_TTY_DISCOVERY_TIMEOUT'
  | 'ERR_NOT_READY'

/** Session kind: a tmux terminal window (default) or an SDK-driven chat. */
export type SessionKind = 'terminal' | 'chat'

/**
 * Who chose a chat session's name (chat-session-naming design D1). `manual` is
 * terminal: once a person has set a name, no generated title replaces it.
 * `placeholder` came from `generateSessionName()`; `auto` was adopted from a
 * title the agent generated and is still followed until a person claims it.
 */
export type ChatNameSource = 'manual' | 'auto' | 'placeholder'

/**
 * A session backed by a tmux window. Everything tmux discovery produces has
 * `tmuxWindow` set; chat sessions do not, so window-keyed code narrows with
 * `isTerminalSession` before touching the field.
 */
export type TerminalSession = Session & { tmuxWindow: string }

export function isTerminalSession(session: Session): session is TerminalSession {
  return session.kind !== 'chat' && session.tmuxWindow !== undefined
}

export interface Session {
  id: string
  name: string
  // Undefined for chat sessions (no tmux window backs them).
  tmuxWindow?: string
  projectPath: string
  status: SessionStatus
  lastActivity: string
  createdAt: string
  // Absent = terminal (back-compat with clients predating chat sessions).
  kind?: SessionKind
  claudeProfileId?: string
  /** Chat sessions only: approval policy; absent = manual (legacy sessions). */
  approvalPolicy?: ChatApprovalPolicy
  /** Chat sessions only: who chose `name`; absent = manual (never overwritten). */
  nameSource?: ChatNameSource
  agentType?: AgentType
  source: SessionSource
  host?: string
  remote?: boolean
  command?: string
  agentSessionId?: string
  agentSessionName?: string
  logFilePath?: string
  lastUserMessage?: string
  isPinned?: boolean
  /** Chat sessions only: archive timestamp (design D1); set = archived. */
  archivedAt?: string | null
}

export interface AgentSession {
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  isActive: boolean
  host?: string
  lastUserMessage?: string
  isPinned?: boolean
  lastResumeError?: string
}

export interface HostStatus {
  host: string
  ok: boolean
  lastUpdated: string
  error?: string
}

// Directory browser types
export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: DirectoryEntry[]
  truncated: boolean
}

export interface DirectoryErrorResponse {
  error: 'invalid_path' | 'forbidden' | 'not_found' | 'internal_error'
  message: string
}

export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-update'; session: Session }
  | { type: 'session-created'; session: Session }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'host-status'; hosts: HostStatus[] }
  | { type: 'agent-sessions'; active: AgentSession[]; hibernating: AgentSession[]; history: AgentSession[] }
  | { type: 'agent-sessions-active'; active: AgentSession[] }
  | { type: 'session-orphaned'; session: AgentSession; supersededBy?: string }
  | { type: 'session-activated'; session: AgentSession; window: string }
  | { type: 'session-wake-result'; sessionId: string; ok: boolean; session?: Session; error?: WakeError }
  | {
      type: 'session-hibernate-result'
      sessionId: string
      ok: boolean
      session?: AgentSession
      error?: string
    }
  | { type: 'session-move-to-history-result'; sessionId: string; ok: boolean; session?: AgentSession; error?: string }
  // Workspace messages are additive: older clients can ignore them and all
  // existing session messages/fields are unchanged.
  | { type: 'workspace-snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'workspace-operation-result'; result: WorkspaceOperationResult }
  | { type: 'terminal-output'; sessionId: string; data: string }
  | {
      type: 'terminal-error'
      sessionId: string | null
      code: TerminalErrorCode
      message: string
      retryable: boolean
    }
  | { type: 'terminal-ready'; sessionId: string }
  | {
      type: 'clipboard-offer'
      sessionId: string
      text: string
      source: ClipboardOfferSource
    }
  | {
      type: 'tmux-copy-mode-status'
      sessionId: string
      inCopyMode: boolean
      // Fullscreen-app (Claude /tui no-flicker) detection, per-pane.
      // altScreen: pane is showing the alternate screen buffer (#{alternate_on}).
      // appMouse: the in-pane app has requested mouse tracking (#{mouse_any_flag}).
      // When appMouse is true the app owns the mouse, so the client must NOT
      // hijack wheel/clicks into tmux copy-mode. Optional for back-compat.
      altScreen?: boolean
      appMouse?: boolean
    }
  | { type: 'server-config'; remoteAllowControl: boolean; remoteAllowAttach: boolean; hostLabel: string; preferWindowName: boolean; clientLogLevel?: string }
  // Chat messages are additive (like the workspace messages above): older
  // clients ignore unknown message types; terminal behavior is unchanged.
  | { type: 'chat-events'; sessionId: string; events: ChatEvent[] }
  | {
      type: 'chat-snapshot'
      sessionId: string
      /** Read-only replayed history plus unfinished live transcript. */
      events: ChatEvent[]
      pendingRequests: ChatPendingRequest[]
      status: SessionStatus
      /** Highest sequence included in this snapshot. */
      throughSequence: number
      /** The session's slash-command list (replaceable state, not history). */
      commands: ChatCommandState
      /** Current in-flight turn activity, or null when the turn is idle. */
      activity: ChatActivity | null
    }
  // Replaced command list pushed to subscribed connections whenever the
  // agent reports a changed list (or the state changes). Additive: older
  // clients ignore the unknown message.
  | { type: 'chat-commands'; sessionId: string; state: ChatCommandState }
  // Ephemeral live activity for an in-flight chat turn (design D1): sent only
  // on phase changes, unordered with events, never persisted or replayed.
  | { type: 'chat-activity'; sessionId: string; activity: ChatActivity | null }
  // Debug-view protocol frames, sent only to clients that opened the view.
  // `page: true` marks a reply to chat-debug-open/chat-debug-page (carrying
  // `hasOlder`); otherwise the message is a live batch.
  | {
      type: 'chat-debug-frames'
      sessionId: string
      frames: ChatWireFrame[]
      page?: boolean
      hasOlder?: boolean
    }
  | { type: 'pong'; seq?: number }
  | { type: 'error'; message: string }
  | { type: 'kill-failed'; sessionId: string; message: string }

export interface WakeError {
  code: 'NOT_FOUND' | 'ALREADY_ACTIVE' | 'WAKE_FAILED' | 'WAKE_IN_PROGRESS'
  message: string
}

export type ClientMessage =
  | {
      type: 'terminal-attach'
      sessionId: string
      tmuxTarget?: string
      cols?: number
      rows?: number
    }
  | { type: 'terminal-detach'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  // Pasted text delivered as a single bracketed paste (via tmux paste-buffer),
  // so multi-line content isn't auto-submitted line-by-line by the pane's app.
  | { type: 'terminal-paste'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | {
      type: 'session-create'
      projectPath: string
      name?: string
      command?: string
      host?: string
      // Session kind: absent = terminal (tmux) session, unchanged behavior;
      // 'chat' creates an SDK-driven chat session instead of a window.
      kind?: SessionKind
      claudeProfileId?: string
      // OpenSpec change context: with a selected agent, the server composes
      // the mapped apply command into the session's start command as the
      // agent's first prompt (a launch argument, held by the agent itself
      // until trust/login gates clear). Absent agent = no first prompt.
      autoStartChange?: string
      autoStartAgent?: AutoStartAgent
    }
  | { type: 'session-kill'; sessionId: string; source?: SessionKillSource }
  | { type: 'session-rename'; sessionId: string; newName: string }
  | { type: 'session-refresh' }
  | { type: 'tmux-cancel-copy-mode'; sessionId: string }
  | { type: 'tmux-check-copy-mode'; sessionId: string }
  | { type: 'session-wake'; sessionId: string }
  | { type: 'session-hibernate'; sessionId: string }
  | { type: 'session-move-to-history'; sessionId: string }
  // Chat messages are additive: existing clients never send them.
  | { type: 'chat-attach'; sessionId: string }
  | { type: 'chat-detach'; sessionId: string }
  | { type: 'chat-send'; sessionId: string; text: string }
  | { type: 'chat-interrupt'; sessionId: string }
  // Archive stops the agent process but keeps the record, conversation, and
  // protocol log; restore clears the archived state (chat-archive design D2).
  // Both idempotent; confirmation for in-flight turns is a client concern (D3).
  | { type: 'chat-archive'; sessionId: string }
  | { type: 'chat-restore'; sessionId: string }
  | {
      type: 'chat-approval'
      sessionId: string
      requestId: string
      decision: ChatApprovalDecision
    }
  | {
      type: 'chat-answer'
      sessionId: string
      requestId: string
      /** Answers keyed by question text (matches the SDK's answer map). */
      answers: Record<string, ChatQuestionAnswer>
    }
  // Switches the session's approval policy live (chat-auto-approve-tools
  // design D4): manual/auto only, no agent restart.
  | {
      type: 'chat-set-approval-policy'
      sessionId: string
      policy: ChatApprovalPolicy
    }
  | { type: 'chat-debug-open'; sessionId: string }
  | { type: 'chat-debug-page'; sessionId: string; beforeSeq: number }
  | { type: 'chat-debug-close'; sessionId: string }
  // Workspace messages are additive; existing clients never send them.
  | { type: 'workspace-refresh'; projectPath?: string }
  | {
      type: 'create-worktree'
      repositoryId: string
      branch: string
      destination: string
      launchSession?: boolean
    }
  | {
      type: 'create-change-worktree'
      repositoryId: string
      change: string
    }
  | { type: 'ping'; seq?: number }

/** Diagnostic metadata attached to parsed ServerMessages by useWebSocket. */
export interface DiagnosticMeta {
  _parseMs: number
  _rawLength: number
}

/** A ServerMessage with diagnostic timing metadata from the WebSocket layer. */
export type ServerMessageWithDiagnostics = ServerMessage & DiagnosticMeta

// Typed function signatures for client-side messaging
export type SendClientMessage = (message: ClientMessage) => void
export type SubscribeServerMessage = (listener: (message: ServerMessage) => void) => () => void
