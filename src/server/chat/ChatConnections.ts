// Per-browser chat subscriptions and ordered event-loop batching. Snapshot
// capture is synchronous so live events cannot overtake the initial snapshot.
// Live-turn activity rides the same flush (design D5): the latest value per
// connection and session is sent after that session's pending event batch, so
// an activity never precedes the tool_call it describes and several phase
// changes within one tick collapse into the last.
// Context usage rides it too (context meter design D5), same per-session
// latest-value coalescing as activity.
// The worker roster rides it as well (workers design D2): the latest full
// projection per connection and session — a level signal, never a delta.
// Plan usage rides it too (usage bar design D4), scoped by profile instead
// of session: one latest-value slot per connection and profile, sent to every
// connection subscribed to at least one session of that profile.
// Notifications ride it as well (notification strip design D5): the full
// merged list per connection and session, replace semantics like the roster.
// Debug-view subscriptions are separate: only connections that opened a
// session's debug view receive its wire frames. They subscribe before the
// async page read, so no frame is missed; clients merge pages and live frames
// by sequence, which makes the resulting overlap harmless.
// Persisted chat rows restore asynchronously at boot and attach history loads
// off the event loop (async-transcript-parsing design D2/D3): every message
// first awaits the one shared restore promise, so arrival order survives it;
// an attach then awaits its history load, and the latest attach/detach of a
// session wins over an attach still loading (the mailbox/task open idiom).
// A disconnect while a message waits drops any subscription it would open.
import type {
  ChatActivity,
  ChatBackgroundTask,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatUsageReport,
  ChatWireFrame,
  ChatWorker,
} from '../../shared/chat'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionManager } from './ChatSessionManager'
import type { ChatWireLogs } from './ChatWireLogs'
import { MailboxConnections } from '../team/mailboxConnections'
import { TaskConnections } from '../team/taskConnections'
import { MessageConnections } from '../team/messageConnections'
import { StrategyConnections } from '../strategy/strategyConnections'
import { WorkspaceConnections } from '../team/workspaceConnections'
import { PlanConnections } from '../plans/planConnections'
import { MetricsConnections } from '../metrics/metricsConnections'
import type { TeamMessage } from '../../shared/team'

/** Frames per debug page reply. */
export const CHAT_DEBUG_PAGE_SIZE = 200
const MAX_BATCH = 128

export interface ChatConnection {
  send(message: ServerMessage): void
}

export class ChatConnections {
  private readonly subscriptions = new Map<ChatConnection, Set<string>>()
  private readonly batches = new Map<ChatConnection, Map<string, ChatEvent[]>>()
  /** Latest activity per connection and session, sent by the next flush. */
  private readonly activityBatches = new Map<ChatConnection, Map<string, ChatActivity | null>>()
  /** Latest context-usage reading per connection and session (design D5). */
  private readonly contextBatches = new Map<ChatConnection, Map<string, ChatContextUsage | null>>()
  /** Latest reported model per connection and session (chat-session-model D3). */
  private readonly modelBatches = new Map<ChatConnection, Map<string, string>>()
  /** Latest usage report per connection and profile, sent by the next flush. */
  private readonly usageBatches = new Map<ChatConnection, Map<string, ChatUsageReport | null>>()
  /** Latest worker roster per connection and session (workers design D2). */
  private readonly workerBatches = new Map<ChatConnection, Map<string, ChatWorker[]>>()
  /** Latest background-task roster per connection and session (background tasks D2). */
  private readonly backgroundTaskBatches = new Map<ChatConnection, Map<string, ChatBackgroundTask[]>>()
  /** Latest notice list per connection and session (notification strip D5). */
  private readonly notificationBatches = new Map<ChatConnection, Map<string, ChatNotification[]>>()
  private readonly debugSubscriptions = new Map<ChatConnection, Map<string, () => void>>()
  private readonly debugBatches = new Map<ChatConnection, Map<string, ChatWireFrame[]>>()
  private scheduled = false
  /** Latest in-flight attach per connection and session (cleared by detach). */
  private readonly pendingAttach = new Map<ChatConnection, Map<string, object>>()
  /** Replaced on disconnect, so messages that waited across it can tell. */
  private readonly epochs = new WeakMap<ChatConnection, object>()

  private readonly mailboxConnections: MailboxConnections
  private readonly taskConnections: TaskConnections
  private readonly messageConnections: MessageConnections
  private readonly strategyConnections: StrategyConnections
  private readonly workspaceConnections: WorkspaceConnections
  private readonly planConnections: PlanConnections
  private readonly metricsConnections: MetricsConnections

  constructor(
    private readonly manager: ChatSessionManager,
    private readonly wireLogs?: ChatWireLogs,
    private readonly broadcastMailboxNotice?: (message: ServerMessage) => void
  ) {
    this.mailboxConnections = new MailboxConnections(manager)
    this.taskConnections = new TaskConnections(manager)
    this.messageConnections = new MessageConnections(manager)
    this.strategyConnections = new StrategyConnections(manager)
    this.workspaceConnections = new WorkspaceConnections(manager)
    this.planConnections = new PlanConnections(manager)
    this.metricsConnections = new MetricsConnections(manager)
  }

  /**
   * A committed task change: re-send that team's task snapshots. The
   * workspace read model derives its rows from tasks and mail, so it rides
   * the same triggers (its own diff keeps an unchanged team quiet).
   */
  publishTasks(teamId: string): void {
    this.taskConnections.publish(teamId)
    this.workspaceConnections.publish(teamId)
  }

  /** A live workspace fact changed outside the task and mailbox paths. */
  publishWorkspace(teamId: string): void {
    this.workspaceConnections.publish(teamId)
  }

  /** Publish the workspace of whichever team the session belongs to. */
  publishWorkspaceOf(sessionId: string): void {
    const teamId = this.manager.teams.teamOf(sessionId)?.teamId
    if (teamId) this.publishWorkspace(teamId)
  }

  /**
   * A chat event that changes workspace facts (team-workspace), the one place
   * the mapping lives so bootstrap's onEvent stays a forward: request and turn
   * events refresh the team's open views — approvals and questions are the
   * queue's human-required items, `request_resolved` removes one, and turn
   * boundaries move the membership's working/waiting status. Turn-end rows
   * themselves are written by the manager's event path (chat_turn_ends, D8).
   */
  observeChatEvent(sessionId: string, event: ChatEvent): void {
    if (
      event.type === 'approval_request' || event.type === 'question_request' ||
      event.type === 'request_resolved' || event.type === 'turn_completed' ||
      event.type === 'turn_started'
    ) this.publishWorkspaceOf(sessionId)
  }

  /** Resolves once every scheduled workspace publish has run (test seam). */
  flushWorkspace(): Promise<void> {
    return this.workspaceConnections.settled()
  }

  /** A committed strategy change: re-send that team's strategy snapshots. */
  publishStrategies(teamId: string): void {
    this.strategyConnections.publish(teamId)
  }

  /** A committed plan write, or a change to a task linked to the plan: re-send its views. */
  publishPlans(teamId: string, planId?: string): void {
    this.planConnections.publish(teamId, planId)
  }

  /** A committed process report or decision: re-send that team's metrics snapshots (never on mail changes). */
  publishMetrics(teamId: string): void {
    this.metricsConnections.publish(teamId)
  }

  disconnect(connection: ChatConnection): void {
    this.epochs.set(connection, {})
    this.pendingAttach.delete(connection)
    this.mailboxConnections.disconnect(connection)
    this.taskConnections.disconnect(connection)
    this.messageConnections.disconnect(connection)
    this.strategyConnections.disconnect(connection)
    this.workspaceConnections.disconnect(connection)
    this.planConnections.disconnect(connection)
    this.metricsConnections.disconnect(connection)
    this.subscriptions.delete(connection)
    this.batches.delete(connection)
    this.activityBatches.delete(connection)
    this.contextBatches.delete(connection)
    this.modelBatches.delete(connection)
    this.usageBatches.delete(connection)
    this.workerBatches.delete(connection)
    this.notificationBatches.delete(connection)
    for (const unsubscribe of this.debugSubscriptions.get(connection)?.values() ?? []) unsubscribe()
    this.debugSubscriptions.delete(connection)
    this.debugBatches.delete(connection)
  }

  /**
   * Push a replaced command list to every connection subscribed to the
   * session. Immediate (not batched): the state is replaceable, not ordered
   * history, so it never waits behind event batching.
   */
  /** Routing rules reloaded: every open mailbox view shows the new status. */
  publishRoutingRules(): void {
    this.mailboxConnections.publishAll()
  }

  publishMailbox(teamId: string, message?: TeamMessage): void {
    this.mailboxConnections.publish(teamId)
    // Task detail lists its mail; a task message changing state changes it.
    if (message?.taskId) this.taskConnections.publish(teamId)
    // The workspace reads mail state and waiting reasons; see publishTasks.
    this.workspaceConnections.publish(teamId)
    if (message?.state === 'dead' && message.reason === 'hop-limit') {
      this.notice(teamId, { type: 'team-mailbox-dead-letter', teamId, messageId: message.id, senderSession: message.fromSession })
    }
    // A reply reached the human (team-message-threads D5): settled on send,
    // no agent turn to show it in, so every connected client gets a toast.
    if (message?.state === 'delivered' && message.toKind === 'human') {
      this.notice(teamId, {
        type: 'team-mailbox-delivered-to-human', teamId, messageId: message.id,
        senderSession: message.fromSession, senderKind: message.fromKind,
      })
    }
  }

  /** A one-off toast for every connection attached to the team's sessions. */
  private notice(teamId: string, notice: ServerMessage): void {
    if (this.broadcastMailboxNotice) { this.broadcastMailboxNotice(notice); return }
    for (const [connection, sessions] of this.subscriptions) {
      if ([...sessions].some(id => this.manager.teams.teamOf(id)?.teamId === teamId)) {
        connection.send(notice)
      }
    }
  }

  publishCommandState(sessionId: string, state: ChatCommandState): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (sessions.has(sessionId)) {
        connection.send({ type: 'chat-commands', sessionId, state })
      }
    }
  }

  publish(sessionId: string, event: ChatEvent): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const batches = this.batches.get(connection) ?? new Map<string, ChatEvent[]>()
      const events = batches.get(sessionId) ?? []
      const previous = events.findLast(candidate => 'turnId' in candidate)
      if (events.length >= MAX_BATCH || (previous && 'turnId' in previous && 'turnId' in event && previous.turnId !== event.turnId)) {
        connection.send({ type: 'chat-events', sessionId, events: [...events] })
        events.length = 0
      }
      events.push(event)
      batches.set(sessionId, events)
      this.batches.set(connection, batches)
    }
    this.scheduleFlush()
  }

  /**
   * Queue the session's current activity for its subscribers (design D5):
   * only the latest value per connection survives until the flush, which
   * sends it after the pending event batch for the same session.
   */
  publishActivity(sessionId: string, activity: ChatActivity | null): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.activityBatches.get(connection) ?? new Map<string, ChatActivity | null>()
      latest.set(sessionId, activity)
      this.activityBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue the session's latest context-usage reading (context meter design
   * D5): like activity, only the latest value per connection and session
   * survives until the flush, which sends it after the pending event batch.
   */
  publishContextUsage(sessionId: string, usage: ChatContextUsage | null): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.contextBatches.get(connection) ?? new Map<string, ChatContextUsage | null>()
      latest.set(sessionId, usage)
      this.contextBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue the session's latest reported model (chat-session-model design D3):
   * like context usage, only the latest value per connection and session
   * survives until the flush. The manager sends only changes, and the value
   * never clears, so each entry is a plain string.
   */
  publishModel(sessionId: string, model: string): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.modelBatches.get(connection) ?? new Map<string, string>()
      latest.set(sessionId, model)
      this.modelBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue the session's current worker roster (workers design D2): the full
   * projection replaces any earlier one per connection and session, and is
   * sent by the flush after that session's pending event batch. A level
   * signal — clients replace, never merge.
   */
  publishWorkers(sessionId: string, workers: ChatWorker[]): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.workerBatches.get(connection) ?? new Map<string, ChatWorker[]>()
      latest.set(sessionId, workers)
      this.workerBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue the session's current background-task roster (background tasks
   * D2): the same replace-semantics level signal as the worker roster — the
   * full set on every change, never a delta.
   */
  publishBackgroundTasks(sessionId: string, tasks: ChatBackgroundTask[]): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.backgroundTaskBatches.get(connection) ?? new Map<string, ChatBackgroundTask[]>()
      latest.set(sessionId, tasks)
      this.backgroundTaskBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue a profile's latest plan-usage report (usage bar design D4): one
   * message per connection subscribed to at least one session of that
   * profile — every session of the profile renders the same data, so the
   * report is not fanned out per session.
   */
  publishUsage(profileId: string, report: ChatUsageReport | null): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!this.subscribesProfile(sessions, profileId)) continue
      const latest = this.usageBatches.get(connection) ?? new Map<string, ChatUsageReport | null>()
      latest.set(profileId, report)
      this.usageBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * Queue a session's current notice list (notification strip design D5):
   * replace semantics per connection and session, sent by the flush after
   * that session's pending event batch — a level signal, never a delta.
   */
  publishNotifications(sessionId: string, notifications: ChatNotification[]): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const latest = this.notificationBatches.get(connection) ?? new Map<string, ChatNotification[]>()
      latest.set(sessionId, notifications)
      this.notificationBatches.set(connection, latest)
    }
    this.scheduleFlush()
  }

  /**
   * The sessions at least one connection is currently subscribed to (the
   * notification strip's slow account-notice recheck scope, design D3).
   */
  subscribedSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const sessions of this.subscriptions.values()) {
      for (const sessionId of sessions) ids.add(sessionId)
    }
    return ids
  }

  /** True when one of the subscribed sessions belongs to the profile. */
  private subscribesProfile(sessions: Set<string>, profileId: string): boolean {
    for (const sessionId of sessions) {
      if (this.manager.profileIdOf(sessionId) === profileId) return true
    }
    return false
  }

  private publishFrame(connection: ChatConnection, sessionId: string, frame: ChatWireFrame): void {
    const batches = this.debugBatches.get(connection) ?? new Map<string, ChatWireFrame[]>()
    const frames = batches.get(sessionId) ?? []
    if (frames.length >= MAX_BATCH) {
      connection.send({ type: 'chat-debug-frames', sessionId, frames: [...frames] })
      frames.length = 0
    }
    frames.push(frame)
    batches.set(sessionId, frames)
    this.debugBatches.set(connection, batches)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (!this.scheduled) {
      this.scheduled = true
      setTimeout(() => this.flush(), 0)
    }
  }

  private flush(): void {
    this.scheduled = false
    const batches = new Map(this.batches)
    this.batches.clear()
    for (const [connection, sessions] of batches) {
      for (const [sessionId, events] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-events', sessionId, events })
        }
      }
    }
    const activityBatches = new Map(this.activityBatches)
    this.activityBatches.clear()
    for (const [connection, sessions] of activityBatches) {
      for (const [sessionId, activity] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-activity', sessionId, activity })
        }
      }
    }
    const contextBatches = new Map(this.contextBatches)
    this.contextBatches.clear()
    for (const [connection, sessions] of contextBatches) {
      for (const [sessionId, usage] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-context-usage', sessionId, usage })
        }
      }
    }
    const modelBatches = new Map(this.modelBatches)
    this.modelBatches.clear()
    for (const [connection, sessions] of modelBatches) {
      for (const [sessionId, model] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-model', sessionId, model })
        }
      }
    }
    const usageBatches = new Map(this.usageBatches)
    this.usageBatches.clear()
    for (const [connection, profiles] of usageBatches) {
      const sessions = this.subscriptions.get(connection)
      if (!sessions) continue
      for (const [profileId, report] of profiles) {
        if (this.subscribesProfile(sessions, profileId)) {
          connection.send({ type: 'chat-usage', profileId, report })
        }
      }
    }
    const workerBatches = new Map(this.workerBatches)
    this.workerBatches.clear()
    for (const [connection, sessions] of workerBatches) {
      for (const [sessionId, workers] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-workers', sessionId, workers })
        }
      }
    }
    const backgroundTaskBatches = new Map(this.backgroundTaskBatches)
    this.backgroundTaskBatches.clear()
    for (const [connection, sessions] of backgroundTaskBatches) {
      for (const [sessionId, tasks] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-background-tasks', sessionId, tasks })
        }
      }
    }
    const notificationBatches = new Map(this.notificationBatches)
    this.notificationBatches.clear()
    for (const [connection, sessions] of notificationBatches) {
      for (const [sessionId, notifications] of sessions) {
        if (this.subscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-notifications', sessionId, notifications })
        }
      }
    }
    const debugBatches = new Map(this.debugBatches)
    this.debugBatches.clear()
    for (const [connection, sessions] of debugBatches) {
      for (const [sessionId, frames] of sessions) {
        if (this.debugSubscriptions.get(connection)?.has(sessionId)) {
          connection.send({ type: 'chat-debug-frames', sessionId, frames })
        }
      }
    }
  }

  private openDebug(connection: ChatConnection, sessionId: string): void {
    const sessions = this.debugSubscriptions.get(connection) ?? new Map<string, () => void>()
    if (!sessions.has(sessionId) && this.wireLogs) {
      sessions.set(sessionId, this.wireLogs.subscribe(sessionId, frame => this.publishFrame(connection, sessionId, frame)))
    } else if (!sessions.has(sessionId)) {
      sessions.set(sessionId, () => {})
    }
    this.debugSubscriptions.set(connection, sessions)
  }

  private unsubscribe(connection: ChatConnection, sessionId: string): void {
    this.subscriptions.get(connection)?.delete(sessionId)
    this.batches.get(connection)?.delete(sessionId)
    this.activityBatches.get(connection)?.delete(sessionId)
    this.contextBatches.get(connection)?.delete(sessionId)
    this.modelBatches.get(connection)?.delete(sessionId)
    this.workerBatches.get(connection)?.delete(sessionId)
    this.notificationBatches.get(connection)?.delete(sessionId)
  }

  private closeDebug(connection: ChatConnection, sessionId: string): void {
    this.debugSubscriptions.get(connection)?.get(sessionId)?.()
    this.debugSubscriptions.get(connection)?.delete(sessionId)
    this.debugBatches.get(connection)?.delete(sessionId)
  }

  private async sendDebugPage(connection: ChatConnection, sessionId: string, beforeSeq?: number): Promise<void> {
    const page = this.wireLogs
      ? await this.wireLogs.readPage(sessionId, {
        limit: CHAT_DEBUG_PAGE_SIZE,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      })
      : { frames: [], hasOlder: false }
    if (!this.debugSubscriptions.get(connection)?.has(sessionId)) return
    connection.send({ type: 'chat-debug-frames', sessionId, frames: page.frames, page: true, hasOlder: page.hasOlder })
  }

  private epochOf(connection: ChatConnection): object {
    let epoch = this.epochs.get(connection)
    if (!epoch) {
      epoch = {}
      this.epochs.set(connection, epoch)
    }
    return epoch
  }

  async handle(connection: ChatConnection, message: ClientMessage): Promise<void> {
    const epoch = this.epochOf(connection)
    // Attaches and detaches of one session order against each other before
    // any await: the latest wins, so a detach (applied right here) can never
    // be overtaken by an earlier attach still loading history.
    const token = {}
    if (message.type === 'chat-attach') {
      const pending = this.pendingAttach.get(connection) ?? new Map<string, object>()
      pending.set(message.sessionId, token)
      this.pendingAttach.set(connection, pending)
    } else if (message.type === 'chat-detach') {
      this.pendingAttach.get(connection)?.delete(message.sessionId)
      this.unsubscribe(connection, message.sessionId)
    }
    await this.manager.whenRestored()
    // Messages that open a subscription are moot once their connection went
    // away while they waited; actions (send, approvals, …) still run.
    if (this.epochs.get(connection) !== epoch && opensSubscription(message.type)) return
    if (message.type.startsWith('team-mailbox-')) return this.mailboxConnections.handle(connection, message)
    if (message.type.startsWith('team-task')) return this.taskConnections.handle(connection, message as Extract<ClientMessage, { type: `team-task${string}` }>)
    if (message.type.startsWith('team-message') || message.type.startsWith('team-thread')) {
      return this.messageConnections.handle(connection, message as Extract<ClientMessage, { type: `team-message${string}` | `team-thread${string}` }>)
    }
    if (message.type.startsWith('strategy-')) return this.strategyConnections.handle(connection, message as Extract<ClientMessage, { type: `strategy-${string}` }>)
    if (message.type.startsWith('team-workspace-')) return this.workspaceConnections.handle(connection, message as Extract<ClientMessage, { type: `team-workspace-${string}` }>)
    if (message.type.startsWith('team-plan')) return this.planConnections.handle(connection, message as Extract<ClientMessage, { type: `team-plan${string}` }>)
    if (message.type.startsWith('process-metrics-')) return this.metricsConnections.handle(connection, message as Extract<ClientMessage, { type: `process-metrics-${string}` }>)
    if (message.type.startsWith('process-proposal-')) return this.metricsConnections.handleCommand(connection, message as Extract<ClientMessage, { type: `process-proposal-${string}` }>)
    if (!message.type.startsWith('chat-') || !('sessionId' in message)) return
    const { sessionId } = message
    if (!this.manager.has(sessionId)) {
      if (this.pendingAttach.get(connection)?.get(sessionId) === token) this.pendingAttach.get(connection)?.delete(sessionId)
      connection.send({ type: 'error', message: `Unknown chat session ${sessionId}` })
      return
    }
    switch (message.type) {
      case 'chat-attach': {
        // History loads off the event loop (design D3) before the sync
        // snapshot assembly; live events are already sequenced after the
        // snapshot send, so the ordering invariant holds by construction.
        // Superseded by a later attach/detach, or dropped by a disconnect.
        await this.manager.loadHistory(sessionId)
        const pending = this.pendingAttach.get(connection)
        if (!pending || pending.get(sessionId) !== token) return
        pending.delete(sessionId)
        const snapshot = this.manager.getSnapshot(sessionId)
        if (!snapshot) return
        this.batches.get(connection)?.delete(sessionId)
        this.activityBatches.get(connection)?.delete(sessionId)
        this.contextBatches.get(connection)?.delete(sessionId)
        this.modelBatches.get(connection)?.delete(sessionId)
        this.workerBatches.get(connection)?.delete(sessionId)
        this.notificationBatches.get(connection)?.delete(sessionId)
        const sessions = this.subscriptions.get(connection) ?? new Set<string>()
        sessions.add(sessionId)
        this.subscriptions.set(connection, sessions)
        connection.send(snapshot)
        // Archived chats attach only for history. Live chats start after the
        // snapshot; report guard/import failures as well as driver errors.
        if (!this.manager.isArchived(sessionId)) {
          const result = await this.manager.start(sessionId)
          if (!result.ok) connection.send({ type: 'error', message: result.error })
        }
        return
      }
      case 'chat-detach':
        // Already unsubscribed before the restore await.
        return
      case 'chat-send': {
        const result = await this.manager.send(sessionId, message.text)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-interrupt': {
        const result = this.manager.interrupt(sessionId)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-archive': {
        // The manager's registry update broadcasts the archived session to
        // every attached client; only failures echo here.
        const result = this.manager.archive(sessionId)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-restore': {
        const result = this.manager.restore(sessionId)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-approval': {
        const result = this.manager.resolveApproval(sessionId, message.requestId, message.decision)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-answer': {
        const result = this.manager.answerQuestion(sessionId, message.requestId, message.answers)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-set-approval-policy': {
        // The manager validates the value; failures echo to the sender only.
        const result = this.manager.setApprovalPolicy(sessionId, message.policy)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-dismiss-notification': {
        // The manager removes the key and pushes the new list to every
        // subscribed connection (notification strip design D6); unknown keys
        // are a no-op that pushes nothing.
        const result = this.manager.dismissNotification(sessionId, message.key)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-debug-open':
        this.openDebug(connection, sessionId)
        await this.sendDebugPage(connection, sessionId)
        return
      case 'chat-debug-page':
        if (!Number.isInteger(message.beforeSeq) || message.beforeSeq < 1) {
          connection.send({ type: 'error', message: 'chat-debug-page needs a positive integer beforeSeq' })
          return
        }
        await this.sendDebugPage(connection, sessionId, message.beforeSeq)
        return
      case 'chat-debug-close':
        this.closeDebug(connection, sessionId)
        return
      case 'chat-worker-transcript': {
        // A read-only body fetch (design D5): the reply is not a broadcast,
        // it goes to the asking connection only.
        connection.send({
          type: 'chat-worker-transcript',
          sessionId,
          workerId: message.workerId,
          ...this.manager.getWorkerTranscript(sessionId, message.workerId),
        })
        return
      }
      case 'chat-task-output': {
        // A read-only tail fetch (background tasks D3), answered to the
        // asking connection only; concurrent asks coalesce server-side.
        connection.send({
          type: 'chat-task-output',
          sessionId,
          taskId: message.taskId,
          ...await this.manager.readTaskOutput(sessionId, message.taskId),
        })
        return
      }
      case 'chat-task-stop': {
        // Fire-and-forget by design (D4): the settle arrives through the
        // roster channel, and refusals are logged, never surfaced.
        await this.manager.stopBackgroundTask(sessionId, message.taskId)
        return
      }
    }
  }
}

/** Message types whose only effect is a subscription for the asking connection. */
function opensSubscription(type: ClientMessage['type']): boolean {
  return type === 'chat-attach' || type === 'chat-debug-open' ||
    type === 'team-mailbox-open' || type === 'team-tasks-open' || type === 'team-task-open' ||
    type === 'team-messages-open' || type === 'team-thread-open' ||
    type === 'strategy-open' || type === 'team-workspace-open' || type === 'team-plans-open' || type === 'team-plan-open' ||
    type === 'process-metrics-open'
}
