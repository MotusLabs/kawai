// Messages-view subscriptions and human sends (team-message-threads 5.1).
// Every request names the team's directory (`teamPath`, team-workspace-pages
// D1); its resolved team scopes what may be seen or sent, and an unknown path
// is refused. The list is a live subscription over the read model's feed:
// an authoritative snapshot of the subscription's own filters on open and
// reconnect, then pushes of the rows that changed. Thread detail follows the
// same discipline — re-sent whole when its thread moves — so a reconnect
// needs no deltas. Human sends and replies run through TeamMailbox as the
// human caller and answer with `team-message-send-result`; the request id is
// the client's and never touches a durable row.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
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
  /** Filters the current watch is over; null when nothing is bound. */
  bound: MessageQueryFilters | null
  /** The feed watch backing this subscription; null until something is open. */
  release: (() => void) | null
}

export class MessageConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /**
   * Latest open/close per connection and target — a team's list, or one
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
    const { teamPath } = message
    const target = `${teamPath}\0${'threadId' in message ? message.threadId : ''}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-messages-close' || message.type === 'team-thread-close') {
      this.close(connection, teamPath, message)
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (message.type === 'team-messages-open') {
      this.open(connection, teamPath, team.teamId, message.filters ?? {}, message.cursor ?? null)
      return
    }
    const threadId = message.threadId
    // Team-scoped like every other read: a thread of another team is empty here.
    if (this.manager.messages.thread(team.teamId, threadId).length === 0) {
      connection.send({ type: 'error', message: 'Message does not belong to this team' })
      return
    }
    this.openThread(connection, teamPath, team.teamId, threadId)
  }

  /** Register (or move) the list subscription; the feed answers with a snapshot. */
  private open(
    connection: ChatConnection,
    teamPath: string,
    teamId: string,
    filters: MessageQueryFilters,
    cursor: MessageCursor | null,
  ) {
    const subscription = this.subscriptionOf(connection, teamPath, teamId)
    subscription.filters = filters
    subscription.cursor = cursor
    subscription.list = true
    this.bind(connection, teamPath, subscription)
    const page = this.manager.messages.snapshot(teamId, filters, cursor)
    this.sendSnapshot(connection, teamPath, subscription, page)
  }

  private openThread(connection: ChatConnection, teamPath: string, teamId: string, threadId: string) {
    const subscription = this.subscriptionOf(connection, teamPath, teamId)
    subscription.threads.add(threadId)
    this.bind(connection, teamPath, subscription)
    this.sendThread(connection, teamPath, teamId, threadId)
  }

  private close(connection: ChatConnection, teamPath: string, message: MessageClientMessage) {
    const views = this.subscriptions.get(connection)
    const subscription = views?.get(teamPath)
    if (!subscription) return
    if (message.type === 'team-thread-close') subscription.threads.delete(message.threadId)
    else subscription.list = false
    if (subscription.list || subscription.threads.size > 0) return
    subscription.release?.()
    views!.delete(teamPath)
    if (views!.size === 0) this.subscriptions.delete(connection)
  }

  private subscriptionOf(connection: ChatConnection, teamPath: string, teamId: string): Subscription {
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === teamId
      ? current
      : {
        teamId, filters: {}, cursor: null, list: false, threads: new Set<string>(),
        bound: null, release: null,
      }
    views.set(teamPath, subscription)
    return subscription
  }

  /**
   * Back the subscription with one feed watch. Re-bound only when the filters
   * move — opening a thread beside an open list must not disturb the page the
   * client is already holding. The watch's own first event is a page-1
   * snapshot, which is never the answer to a cursor page and never what a
   * thread open asked for, so it is ignored here: each open sends the page it
   * actually requested, and only that one.
   */
  private bind(connection: ChatConnection, teamPath: string, subscription: Subscription) {
    if (subscription.release && subscription.bound === subscription.filters) return
    subscription.release?.()
    subscription.bound = subscription.filters
    subscription.release = this.manager.messages.watch(subscription.teamId, subscription.filters, event =>
      this.push(connection, teamPath, subscription, event))
  }

  private push(
    connection: ChatConnection,
    teamPath: string,
    subscription: Subscription,
    event: MessageFeedEvent,
  ) {
    if (this.subscriptions.get(connection)?.get(teamPath) !== subscription) return
    if (event.kind === 'snapshot') return
    // Unfiltered on purpose: a watcher on `state:queued` has to hear about
    // the claim that drops a row out of its list.
    if (subscription.list) {
      connection.send({
        type: 'team-messages', teamPath, teamId: subscription.teamId, messages: event.messages,
      })
    }
    const touched = new Set(event.messages.map(message => message.threadId))
    for (const threadId of subscription.threads) {
      if (touched.has(threadId)) this.sendThread(connection, teamPath, subscription.teamId, threadId)
    }
  }

  private sendSnapshot(
    connection: ChatConnection,
    teamPath: string,
    subscription: Subscription,
    page: MessagePage,
  ) {
    connection.send({
      type: 'team-messages-snapshot', teamPath, teamId: subscription.teamId,
      filters: subscription.filters, messages: page.messages, nextCursor: page.nextCursor, threadSizes: page.threadSizes,
      directory: this.manager.directory.list(subscription.teamId),
      tasks: this.manager.tasks.store.list(subscription.teamId).map(task => ({ id: task.id, title: task.title })),
    })
  }

  private sendThread(connection: ChatConnection, teamPath: string, teamId: string, threadId: string) {
    connection.send({
      type: 'team-thread', teamPath, teamId, threadId,
      entries: this.manager.messages.thread(teamId, threadId),
      directory: this.manager.directory.list(teamId),
    })
  }

  /** A human send or reply, as the human caller for the addressed team. */
  private async act(connection: ChatConnection, message: Extract<MessageClientMessage, { requestId: string }>) {
    const { teamPath, requestId } = message
    const fail = (error: string) =>
      connection.send({ type: 'team-message-send-result', teamPath, requestId, error })
    const bothOrNeither = (message.to !== undefined) === (message.inReplyTo !== undefined)
    if (bothOrNeither) return fail('Provide exactly one of to or inReplyTo')
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) return fail(unknownTeamError(teamPath))
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
      connection.send({ type: 'team-message-send-result', teamPath, requestId, message: sent })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
}
