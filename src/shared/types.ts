// History sessions lookback limits (in hours)
export const HISTORY_MAX_AGE_MIN_HOURS = 1
export const HISTORY_MAX_AGE_MAX_HOURS = 168 // 7 days

import type { TeamMessage } from './team'
import type { RuleLoadReport, TeamRoutingState } from './routing'
import type { TaskStatus, TeamTask, TeamTaskDetail, TeamTaskSummary } from './teamTasks'
import type { ProductStrategy, StrategyDetail, StrategyDraft, StrategyRevision } from './productStrategy'
import type {
  WorkspaceOperationResult,
  WorkspaceSnapshot,
} from './workspace'
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatUsageReport,
  ChatWireFrame,
  ChatWorker,
} from './chat'

export type {
  ChatActivity,
  ChatActivityPhase,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatNotificationSource,
  ChatNotificationSeverity,
  ChatNotificationPriority,
  ChatUsageReport,
  ChatUsageWindow,
  ChatUsageStatus,
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
  ChatWorker,
  ChatWorkerStatus,
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
  /** Chat sessions only: team group id (agent-teams); absent = no group. */
  groupId?: string
  /** The group's display label; absent until the session's team is known. */
  groupLabel?: string
  /** True when no group file defines `groupId` any more. */
  groupMissing?: boolean
  /** Chat sessions only: the team task it works on (team-tasks); absent = none. */
  taskId?: string
  /** That task's current title; absent when the task is unknown. */
  taskTitle?: string
  /** Created by worktree staffing, not by the human (team-tasks D4). */
  spawned?: boolean
  /** Paused after a provider limit with work parked on it (profile routing); null/absent = not paused. */
  parked?: SessionParkedState | null
}

/** Why and until when a chat session is paused (profile routing). */
export interface SessionParkedState {
  messageId: string
  /** When the scheduled resume is due; null when unknown. */
  until: string | null
  profileId: string
  reason: string
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

/**
 * The server's update-discovery result: the running build, and the release
 * to offer when a newer base version exists. `target` is null while the
 * running base is current (or discovery has not found anything), so a
 * missing signal and a current build look the same — by design, discovery
 * fails silent.
 */
export interface UpdateState {
  /** Running build version, e.g. `1.0.0-17` or `1.0.0-dev`. */
  current: string
  /** The release an update would move to; null when current. */
  target: null | {
    /** Release tag, e.g. `v1.1.0-12`. */
    tag: string
    /** `MAJOR.MINOR.PATCH` base of the tag. */
    base: string
    /** Release page, when the API provided one. */
    htmlUrl: null | string
  }
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
  // Update availability is additive too: older clients ignore it, and the
  // payload rides server-info for first paint and this push for changes.
  | { type: 'update-state'; update: UpdateState }
  // Chat messages are additive (like the workspace messages above): older
  // clients ignore unknown message types; terminal behavior is unchanged.
  | { type: 'chat-events'; sessionId: string; events: ChatEvent[] }
  | {
      type: 'chat-snapshot'
      sessionId: string
      /** Claude profile of the session; keys the client's per-profile usage. */
      profileId: string
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
      /**
       * Latest context-usage reading for the session, or null before the
       * first model request (context meter design D7: no reading is a state,
       * not a zero). Slow session state like `status`, not ephemeral like
       * `activity` — it also persists with the chat session.
       */
      contextUsage: ChatContextUsage | null
      /**
       * Model the agent last reported for the session (its init frame), or
       * null before the first report — slow session state like
       * `contextUsage`, persisted with the chat session, never a sequenced
       * event.
       */
      model: string | null
      /** Latest plan-usage report for the session's profile, when one is held. */
      usage: ChatUsageReport | null
      /**
       * Agents the session spawned (workers design D2): the full roster at
       * snapshot time — running ones live, settled ones with their outcomes.
       */
      workers: ChatWorker[]
      /**
       * The session's active notices (notification strip design D1): its
       * profile's account notices followed by its own agent notices, sorted by
       * priority and newest. Additive and ephemeral — never persisted,
       * sequenced, or replayed.
       */
      notifications: ChatNotification[]
    }
  // Replaced command list pushed to subscribed connections whenever the
  // agent reports a changed list (or the state changes). Additive: older
  // clients ignore the unknown message.
  | { type: 'chat-commands'; sessionId: string; state: ChatCommandState }
  // Ephemeral live activity for an in-flight chat turn (design D1): sent only
  // on phase changes, unordered with events, never persisted or replayed.
  | { type: 'chat-activity'; sessionId: string; activity: ChatActivity | null }
  // Latest plan usage for a Claude profile (usage bar design D4): sent once to
  // every connection subscribed to at least one session of the profile when a
  // new report is captured. Additive and ephemeral like chat-activity.
  | { type: 'chat-usage'; profileId: string; report: ChatUsageReport | null }
  // Latest context-usage reading for a chat session (context meter design D5):
  // coalesced like chat-activity — only the latest value survives until the
  // flush — additive, never sequenced or replayed. A null `usage` clears the
  // meter (a conversation reset leaves nothing measured, design D7).
  | {
      type: 'chat-context-usage'
      sessionId: string
      usage: ChatContextUsage | null
    }
  // Model the agent last reported for a chat session (its init frame): sent
  // only when it changes — the value never clears, so the push carries a
  // string. Coalesced like chat-context-usage; additive, never sequenced or
  // replayed (the snapshot carries the current value instead).
  | { type: 'chat-model'; sessionId: string; model: string }
  // Full worker roster of a chat session (workers design D2): a level signal,
  // not deltas — a missed bookend must not wedge a stale running worker. Sent
  // whenever the roster projection changes; additive and ephemeral like
  // chat-activity, while settled outcomes also ride the snapshot and persist.
  | { type: 'team-mailbox-snapshot'; sessionId: string; teamId: string; messages: TeamMessage[]; routing?: TeamRoutingState }
  | { type: 'team-mailbox-rules-result'; sessionId: string; ok: true; report: RuleLoadReport }
  | { type: 'team-mailbox-rules-result'; sessionId: string; ok: false; error: string }
  | { type: 'team-mailbox-hand-off-result'; sessionId: string; messageId: string; ok: true; forwardedId: string }
  | { type: 'team-mailbox-hand-off-result'; sessionId: string; messageId: string; ok: false; error: string }
  | { type: 'team-mailbox-dead-letter'; teamId: string; messageId: string; senderSession: string }
  // Team tasks (team-tasks 6.1): authoritative snapshots for a session's
  // team — the list, and each task whose detail the connection has open.
  | { type: 'team-tasks-snapshot'; sessionId: string; teamId: string; tasks: TeamTaskSummary[] }
  | { type: 'team-task-detail'; sessionId: string; teamId: string; detail: TeamTaskDetail }
  // Result of a human task action; `task` is set on success (a created
  // task's id lets the view open it), `error` on refusal.
  | { type: 'team-task-result'; sessionId: string; requestId: string; task?: TeamTask; error?: string }
  // Product strategy (product-strategy 3.1/5.1): authoritative snapshots for
  // a session's team — the summary (null = no record; the view offers
  // capture) and, when a record exists, its full detail. Re-sent whole on
  // every committed strategy change, so a reconnect needs no deltas.
  | { type: 'strategy-snapshot'; sessionId: string; teamId: string; strategy: ProductStrategy | null }
  | { type: 'strategy-detail'; sessionId: string; teamId: string; detail: StrategyDetail }
  // Result of a human strategy action: the saved draft (its hash feeds the
  // next save's CAS) or the submitted revision on success; `error` on
  // refusal, with `conflict` carrying the stored draft when a CAS refusal
  // leaves the caller's own text in place (S12).
  | {
      type: 'strategy-result'
      sessionId: string
      requestId: string
      draft?: StrategyDraft
      revision?: StrategyRevision
      error?: string
      conflict?: StrategyDraft | null
    }
  | { type: 'chat-workers'; sessionId: string; workers: ChatWorker[] }
  // A chat session's active notices (notification strip design D5): the full
  // replace-semantics list, pushed to subscribed connections whenever it
  // changes — a missed push heals on the next one. Additive and ephemeral
  // like chat-activity: never sequenced, persisted, or replayed.
  | { type: 'chat-notifications'; sessionId: string; notifications: ChatNotification[] }
  // A worker's body on expand (workers design D5): the reply to
  // chat-worker-transcript, read from the worker's on-disk transcript.
  // 'unavailable' reports a missing file or unknown worker (the row shows
  // the body as unavailable, never an error).
  | {
      type: 'chat-worker-transcript'
      sessionId: string
      workerId: string
      status: 'ok' | 'unavailable'
      events: ChatEvent[]
    }
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
      // Chat sessions only: starting approval policy (reorg-settings-default-
      // approval design D3). Absent = manual, so older clients and terminal
      // sessions are unchanged.
      approvalPolicy?: ChatApprovalPolicy
      // Chat sessions only: team group (agent-teams), validated against the
      // project's group catalog and fixed for the session's life. Absent =
      // no group.
      groupId?: string
      /** Existing chat whose stored role is preserved, including a missing role. */
      cloneFromSessionId?: string
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
  | { type: 'team-mailbox-open' | 'team-mailbox-close'; sessionId: string }
  | { type: 'team-mailbox-cancel' | 'team-mailbox-retry' | 'team-mailbox-discard'; sessionId: string; messageId: string }
  | { type: 'team-mailbox-reload-rules'; sessionId: string }
  | { type: 'team-mailbox-hand-off'; sessionId: string; messageId: string; target: { kind: 'group' | 'session'; id: string } }
  // Team tasks (team-tasks 6.1/6.2): list and detail subscriptions scoped by
  // the session's team; human actions answer with team-task-result.
  | { type: 'team-tasks-open' | 'team-tasks-close'; sessionId: string }
  | { type: 'team-task-open' | 'team-task-close'; sessionId: string; taskId: string }
  | {
      type: 'team-task-create'
      sessionId: string
      requestId: string
      title: string
      direction: string
      acceptance?: string
      parentId?: string
      worktree?: string
      openspecChange?: string
    }
  | { type: 'team-task-amend'; sessionId: string; requestId: string; taskId: string; direction?: string; acceptance?: string }
  | { type: 'team-task-note'; sessionId: string; requestId: string; taskId: string; text: string }
  | { type: 'team-task-status'; sessionId: string; requestId: string; taskId: string; status: TaskStatus }
  // Product strategy (product-strategy 3.1/5.1): the view subscription
  // scoped by the session's team, and the human actions. Approval and
  // withdrawal arrive only here — there is no agent tool for them (D3).
  | { type: 'strategy-open' | 'strategy-close'; sessionId: string }
  | {
      type: 'strategy-save-draft'
      sessionId: string
      requestId: string
      /** Capture (no record yet, human only): the product slug and title. */
      productId?: string
      title?: string
      draftId?: string
      /** Template content object; normalized server-side. */
      content: unknown
      impactProposal?: string
      expectedBaseRevision?: number | null
      expectedDraftHash?: string | null
    }
  | { type: 'strategy-submit'; sessionId: string; requestId: string; draftId?: string }
  | {
      type: 'strategy-approve'
      sessionId: string
      requestId: string
      revision: number
      contentHash: string
      /** Stable across retries: idempotency key (S17). */
      commandId: string
      /** CAS: the active approved revision the client saw (D4). */
      expectedCurrentRevision: number | null
      approvalScope?: string
      openQuestions?: string
    }
  | { type: 'strategy-withdraw'; sessionId: string; requestId: string; revision?: number; draftId?: string; commandId: string }
  | { type: 'chat-debug-open'; sessionId: string }
  | { type: 'chat-debug-page'; sessionId: string; beforeSeq: number }
  | { type: 'chat-debug-close'; sessionId: string }
  // A worker's expanded body (workers design D5): read the worker's on-disk
  // transcript live or after settle; the reply is chat-worker-transcript.
  | { type: 'chat-worker-transcript'; sessionId: string; workerId: string }
  // Close an agent notice for its session on the server (notification strip
  // design D6): the manager drops the key and pushes the new list to every
  // attached client; unknown keys are a no-op. Account notices are closed
  // client-side only and never send this. Additive: existing clients never
  // send it.
  | { type: 'chat-dismiss-notification'; sessionId: string; key: string }
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
