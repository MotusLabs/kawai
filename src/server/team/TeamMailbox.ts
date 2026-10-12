// Sender-bound mailbox operations. Identity always comes from the current
// session record; tool arguments can only choose a recipient, content, and
// (team-tasks) a task of the sender's own team. A reply without a task id
// keeps the task of the message it answers. Urgent direct mail to an agent
// whose profile is cooling after a provider limit is refused (profile
// routing): it could neither interrupt usefully nor run.
import type { ChatSessionRecord } from '../db'
import { loadTeamGroups } from './teamGroups'
import { resolveTeam, type TeamIdentity } from './teamIdentity'
import { MailboxStore, type TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'

export interface MailInput {
  to_kind: 'group' | 'session'
  to_id: string
  body: string
  urgent?: boolean
  tags?: string[]
  task_id?: string
}

export class TeamMailbox {
  constructor(readonly store: MailboxStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
    onChange?: (message: TeamMessage) => void
    restoreSession?: (id: string) => void | Promise<void>
    tasks?: TaskStore
    /** Built-in cooldown end (ISO) of a profile, or null. */
    cooldownUntil?: (profileId: string) => string | null
  }) {}

  /** Refuse urgent direct mail to an agent whose profile is cooling; nothing is queued. */
  private refuseCooling(recipient: ChatSessionRecord, urgent: boolean | undefined) {
    if (!urgent) return
    const profileId = recipient.claudeProfileId ?? 'default'
    const until = this.options.cooldownUntil?.(profileId)
    if (!until) return
    const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    throw new Error(`Session ${recipient.sessionId} runs on profile ${profileId}, which is cooling down after a provider limit until ${time} (${until}). ` +
      'Send it without urgent to queue it, or send it to another agent.')
  }

  /** A task id of the sender's team, or an error; nothing is enqueued on failure. */
  private taskOf(team: TeamIdentity, taskId: string | undefined): string | null {
    if (!taskId) return null
    const task = this.options.tasks?.get(taskId)
    if (!task || task.teamId !== team.teamId) throw new Error(`Task not found in this team: ${taskId}`)
    return task.id
  }

  private async context(sessionId: string) {
    const sender = this.options.getSession(sessionId)
    if (!sender) throw new Error(`Unknown sending session: ${sessionId}`)
    const { team, catalog } = await loadTeamGroups(sender.projectPath, this.options.homeDir)
    return { sender, team, catalog }
  }

  async listGroups(sessionId: string) {
    const { catalog } = await this.context(sessionId)
    return [...catalog.groups.values()].map(({ id, label, description }) => ({ id, label, description }))
  }

  async send(sessionId: string, input: MailInput, deliverAt?: string): Promise<TeamMessage> {
    const { sender, team, catalog } = await this.context(sessionId)
    const taskId = this.taskOf(team, input.task_id)
    if (input.to_kind === 'group') {
      if (!catalog.groups.has(input.to_id)) throw new Error(`Unknown group: ${input.to_id}`)
    } else {
      const recipient = this.options.getSession(input.to_id)
      if (!recipient) throw new Error(`Unknown recipient session: ${input.to_id}`)
      if ((await resolveTeam(recipient.projectPath)).teamId !== team.teamId) {
        throw new Error('Recipient belongs to another team')
      }
      this.refuseCooling(recipient, input.urgent)
      // Direct mail resumes an archived recipient, exactly as replies do:
      // otherwise the message could queue forever behind a parked session.
      if (recipient.archivedAt) await this.options.restoreSession?.(recipient.sessionId)
    }
    return this.publish(this.store.enqueue({
      teamId: team.teamId, toKind: input.to_kind, toId: input.to_id,
      fromSession: sender.sessionId, fromGroup: sender.groupId ?? null,
      originPath: sender.projectPath, body: input.body,
      priority: input.urgent ? 'urgent' : 'normal', tags: input.tags,
      hopLimit: sender.groupId ? catalog.groups.get(sender.groupId)?.hopLimit : undefined,
      deliverAt, taskId,
    }))
  }

  async schedule(sessionId: string, input: MailInput & { deliver_at?: string; delay_seconds?: number }) {
    if ((input.deliver_at === undefined) === (input.delay_seconds === undefined)) {
      throw new Error('Provide exactly one of deliver_at or delay_seconds')
    }
    const due = input.deliver_at === undefined
      ? Date.now() + input.delay_seconds! * 1000 : Date.parse(input.deliver_at)
    if (!Number.isFinite(due) || (input.delay_seconds !== undefined && input.delay_seconds < 0)) {
      throw new Error('Invalid scheduled delivery time')
    }
    return this.send(sessionId, input, new Date(due).toISOString())
  }

  async reply(sessionId: string, input: { message_id: string; body: string; urgent?: boolean; tags?: string[]; task_id?: string }) {
    const { sender, team, catalog } = await this.context(sessionId)
    const explicitTask = this.taskOf(team, input.task_id)
    const original = this.store.get(input.message_id)
    if (!original || original.teamId !== team.teamId || original.claimedBy !== sessionId || original.deliveredAt === null) {
      throw new Error('Can only reply to a message received by this session')
    }
    const recipient = this.options.getSession(original.fromSession)
    if (recipient && (await resolveTeam(recipient.projectPath)).teamId !== team.teamId) {
      throw new Error('Recipient belongs to another team')
    }
    if (recipient) this.refuseCooling(recipient, input.urgent)
    if (recipient?.archivedAt) await this.options.restoreSession?.(recipient.sessionId)
    const fallback = !recipient && original.fromGroup !== null
    const message = this.store.enqueue({
      teamId: team.teamId, toKind: fallback ? 'group' : 'session',
      toId: fallback ? original.fromGroup! : original.fromSession,
      fromSession: sender.sessionId, fromGroup: sender.groupId ?? null,
      originPath: sender.projectPath, body: input.body,
      priority: input.urgent ? 'urgent' : 'normal', tags: input.tags,
      inReplyTo: original, attachThread: fallback,
      taskId: explicitTask ?? original.taskId,
      hopLimit: sender.groupId ? catalog.groups.get(sender.groupId)?.hopLimit : undefined,
    })
    if (!recipient && (!fallback || !catalog.groups.has(original.fromGroup!))) {
      this.store.deadLetter(message.id, 'killed-sender-without-group')
    }
    return this.publish(this.store.get(message.id)!)
  }

  private publish(message: TeamMessage) {
    this.options.onChange?.(message)
    return message
  }
}
