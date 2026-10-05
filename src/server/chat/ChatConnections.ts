// Per-browser chat subscriptions and ordered event-loop batching. Snapshot
// capture is synchronous so live events cannot overtake the initial snapshot.
import type { ChatEvent } from '../../shared/chat'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionManager } from './ChatSessionManager'

export interface ChatConnection {
  send(message: ServerMessage): void
}

export class ChatConnections {
  private readonly subscriptions = new Map<ChatConnection, Set<string>>()
  private readonly batches = new Map<ChatConnection, Map<string, ChatEvent[]>>()
  private scheduled = false

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection): void {
    this.subscriptions.delete(connection)
    this.batches.delete(connection)
  }

  publish(sessionId: string, event: ChatEvent): void {
    for (const [connection, sessions] of this.subscriptions) {
      if (!sessions.has(sessionId)) continue
      const batches = this.batches.get(connection) ?? new Map<string, ChatEvent[]>()
      const events = batches.get(sessionId) ?? []
      const previous = events.findLast(candidate => 'turnId' in candidate)
      if (events.length >= 128 || (previous && 'turnId' in previous && 'turnId' in event && previous.turnId !== event.turnId)) {
        connection.send({ type: 'chat-events', sessionId, events: [...events] })
        events.length = 0
      }
      events.push(event)
      batches.set(sessionId, events)
      this.batches.set(connection, batches)
    }
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
        const sessions = this.subscriptions.get(connection) ?? new Set<string>()
        sessions.add(sessionId)
        this.subscriptions.set(connection, sessions)
        connection.send(snapshot)
        return
      }
      case 'chat-detach':
        this.subscriptions.get(connection)?.delete(sessionId)
        this.batches.get(connection)?.delete(sessionId)
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
      case 'chat-approval': {
        const result = this.manager.resolveApproval(sessionId, message.requestId, message.decision)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
        return
      }
      case 'chat-answer': {
        const result = this.manager.answerQuestion(sessionId, message.requestId, message.answers)
        if (!result.ok) connection.send({ type: 'error', message: result.error })
      }
    }
  }
}
