// Per-browser chat subscriptions and ordered event-loop batching. Snapshot
// capture is synchronous so live events cannot overtake the initial snapshot.
// Live-turn activity rides the same flush (design D5): the latest value per
// connection and session is sent after that session's pending event batch, so
// an activity never precedes the tool_call it describes and several phase
// changes within one tick collapse into the last.
// Plan usage rides it too (usage bar design D4), scoped by profile instead of
// session: one latest-value slot per connection and profile, sent to every
// connection subscribed to at least one session of that profile.
// Debug-view subscriptions are separate: only connections that opened a
// session's debug view receive its wire frames. They subscribe before the
// async page read, so no frame is missed; clients merge pages and live frames
// by sequence, which makes the resulting overlap harmless.
import type {
  ChatActivity,
  ChatCommandState,
  ChatEvent,
  ChatUsageReport,
  ChatWireFrame,
} from '../../shared/chat'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionManager } from './ChatSessionManager'
import type { ChatWireLogs } from './ChatWireLogs'

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
  /** Latest usage report per connection and profile, sent by the next flush. */
  private readonly usageBatches = new Map<ChatConnection, Map<string, ChatUsageReport | null>>()
  private readonly debugSubscriptions = new Map<ChatConnection, Map<string, () => void>>()
  private readonly debugBatches = new Map<ChatConnection, Map<string, ChatWireFrame[]>>()
  private scheduled = false

  constructor(
    private readonly manager: ChatSessionManager,
    private readonly wireLogs?: ChatWireLogs
  ) {}

  disconnect(connection: ChatConnection): void {
    this.subscriptions.delete(connection)
    this.batches.delete(connection)
    this.activityBatches.delete(connection)
    this.usageBatches.delete(connection)
    for (const unsubscribe of this.debugSubscriptions.get(connection)?.values() ?? []) unsubscribe()
    this.debugSubscriptions.delete(connection)
    this.debugBatches.delete(connection)
  }

  /**
   * Push a replaced command list to every connection subscribed to the
   * session. Immediate (not batched): the state is replaceable, not ordered
   * history, so it never waits behind event batching.
   */
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

  async handle(connection: ChatConnection, message: ClientMessage): Promise<void> {
    if (!message.type.startsWith('chat-') || !('sessionId' in message)) return
    const { sessionId } = message
    if (!this.manager.has(sessionId)) {
      connection.send({ type: 'error', message: `Unknown chat session ${sessionId}` })
      return
    }
    switch (message.type) {
      case 'chat-attach': {
        const snapshot = this.manager.getSnapshot(sessionId)
        if (!snapshot) return
        this.batches.get(connection)?.delete(sessionId)
        this.activityBatches.get(connection)?.delete(sessionId)
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
        this.subscriptions.get(connection)?.delete(sessionId)
        this.batches.get(connection)?.delete(sessionId)
        this.activityBatches.get(connection)?.delete(sessionId)
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
    }
  }
}
