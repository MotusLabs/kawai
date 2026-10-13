// Messages-view subscriptions and human sends (team-message-threads 5.1).
// Every request names a chat session; its resolved team scopes what may be
// seen or sent. The list is a live subscription over the read model's feed:
// an authoritative snapshot of the subscription's own filters on open and
// reconnect, then pushes of the rows that changed. Thread detail follows the
// same discipline — re-sent whole when its thread moves — so a reconnect
// needs no deltas. Human sends and replies run through TeamMailbox as the
// human caller and answer with `team-message-send-result`; the request id is
// the client's and never touches a durable row.
import type { ClientMessage } from '../../shared/types'
import type {
  MessageCursor,
  MessagePage,
  MessageQueryFilters,
} from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { MessageFeedEvent } from './messageFeed'

type MessageClientMessage = Extract<ClientMessage, { type: `team-message${string}` | `team-thread${string}` }>

interface Subscription {
  teamId: string
  filters: MessageQueryFilters
  cursor: MessageCursor | null
  list: boolean
  threads: Set<string>
  /** The feed watch backing this subscription; null until something is open. */
  release: (() => void) | null
}

export class MessageConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /**
   * Latest open/close per connection and target — a session's list, or one
   * thread of it. Only a later open/close of the same target supersedes a
   * pending open: a list and a thread opened together must both stand.
   */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    for (const subscription of this.subscriptions.get(connection)?.values() ?? []) subscription.release?.()
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  async handle(connection: ChatConnection, message: MessageClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    const { sessionId } = message
    const target = `${sessionId}\0${'threadId' in message ? message.threadId : ''}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-messages-close' || message.type === 'team-thread-close') {
      this.close(connection, sessionId, message)
      return
    }
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'error', message: 'Chat team is unavailable' })
      return
    }
    if (message.type === 'team-messages-open') {
      this.open(connection, sessionId, team.teamId, message.filters ?? {}, message.cursor ?? null)
      return
    }
    const threadId = message.threadId
    // Team-scoped like every other read: a thread of another team is empty here.
    if (this.manager.messages.thread(team.teamId, threadId).length === 0) {
      connection.send({ type: 'error', message: 'Message does not belong to this team' })
      return
    }
    this.openThread(connection, sessionId, team.teamId, threadId)
  }

  /** Register (or move) the list subscription; the feed answers with a snapshot. */
  private open(
    connection: ChatConnection,
    sessionId: string,
    teamId: string,
    filters: MessageQueryFilters,
    cursor: MessageCursor | null,
  ) {
    const subscription = this.subscriptionOf(connection, sessionId, teamId)
    subscription.filters = filters
    subscription.cursor = cursor
    subscription.list = true
    this.bind(connection, sessionId, subscription)
    const page = this.manager.messages.snapshot(teamId, filters, cursor)
    this.sendSnapshot(connection, sessionId, subscription, page)
  }

  private openThread(connection: ChatConnection, sessionId: string, teamId: string, threadId: string) {
    const subscription = this.subscriptionOf(connection, sessionId, teamId)
    subscription.threads.add(threadId)
    this.bind(connection, sessionId, subscription)
    this.sendThread(connection, sessionId, teamId, threadId)
  }

  private close(connection: ChatConnection, sessionId: string, message: MessageClientMessage) {
    const sessions = this.subscriptions.get(connection)
    const subscription = sessions?.get(sessionId)
    if (!subscription) return
    if (message.type === 'team-thread-close') subscription.threads.delete(message.threadId)
    else subscription.list = false
    if (subscription.list || subscription.threads.size > 0) return
    subscription.release?.()
    sessions!.delete(sessionId)
    if (sessions!.size === 0) this.subscriptions.delete(connection)
  }

  private subscriptionOf(connection: ChatConnection, sessionId: string, teamId: string): Subscription {
    const sessions = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, sessions)
    const current = sessions.get(sessionId)
    const subscription = current?.teamId === teamId
      ? current
      : { teamId, filters: {}, cursor: null, list: false, threads: new Set<string>(), release: null }
    sessions.set(sessionId, subscription)
    return subscription
  }

  /**
   * Back the subscription with one feed watch. Re-bound whenever the list
   * moves to new filters: the watch's first event is that page's snapshot.
   */
  private bind(connection: ChatConnection, sessionId: string, subscription: Subscription) {
    subscription.release?.()
    subscription.release = this.manager.messages.watch(subscription.teamId, subscription.filters, event =>
      this.push(connection, sessionId, subscription, event))
  }

  private push(
    connection: ChatConnection,
    sessionId: string,
    subscription: Subscription,
    event: MessageFeedEvent,
  ) {
    if (this.subscriptions.get(connection)?.get(sessionId) !== subscription) return
    if (event.kind === 'snapshot') {
      if (subscription.list) this.sendSnapshot(connection, sessionId, subscription, event.page)
      return
    }
    // Unfiltered on purpose: a watcher on `state:queued` has to hear about
    // the claim that drops a row out of its list.
    if (subscription.list) {
      connection.send({
        type: 'team-messages', sessionId, teamId: subscription.teamId, messages: event.messages,
      })
    }
    const touched = new Set(event.messages.map(message => message.threadId))
    for (const threadId of subscription.threads) {
      if (touched.has(threadId)) this.sendThread(connection, sessionId, subscription.teamId, threadId)
    }
  }

  private sendSnapshot(
    connection: ChatConnection,
    sessionId: string,
    subscription: Subscription,
    page: MessagePage,
  ) {
    connection.send({
      type: 'team-messages-snapshot', sessionId, teamId: subscription.teamId,
      filters: subscription.filters, messages: page.messages, nextCursor: page.nextCursor,
    })
  }

  private sendThread(connection: ChatConnection, sessionId: string, teamId: string, threadId: string) {
    connection.send({
      type: 'team-thread', sessionId, teamId, threadId,
      entries: this.manager.messages.thread(teamId, threadId),
    })
  }

  /** A human send or reply, as the human caller for the session's team. */
  private async act(connection: ChatConnection, message: Extract<MessageClientMessage, { requestId: string }>) {
    const { sessionId, requestId } = message
    const fail = (error: string) =>
      connection.send({ type: 'team-message-send-result', sessionId, requestId, error })
    const bothOrNeither = (message.to !== undefined) === (message.inReplyTo !== undefined)
    if (bothOrNeither) return fail('Provide exactly one of to or inReplyTo')
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (!this.manager.has(sessionId) || !team) return fail('Chat team is unavailable')
    const caller = { kind: 'human' as const, team }
    const extras = {
      ...(message.urgent !== undefined ? { urgent: message.urgent } : {}),
      ...(message.tags ? { tags: message.tags } : {}),
      ...(message.taskId ? { task_id: message.taskId } : {}),
    }
    try {
      const sent = message.inReplyTo !== undefined
        ? await this.manager.mailbox.reply(caller, {
          message_id: message.inReplyTo, body: message.body, ...extras,
        })
        : await this.manager.mailbox.send(caller, {
          to_kind: message.to!.kind, to_id: message.to!.id, body: message.body, ...extras,
        })
      connection.send({ type: 'team-message-send-result', sessionId, requestId, message: sent })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
}
