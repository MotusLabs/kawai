// Sender-bound mailbox operations. Identity always comes from the caller —
// the agent's current session record, or the human through the authenticated
// UI connection — never from tool arguments. The human is a first-class
// sender (team-message-threads D4): `from_kind: 'human'` with no session, and
// their reply to a human-started thread is the only mail that targets them
// (D5, settled on send). A reply without a task id keeps the task of the
// message it answers. Urgent direct mail to an agent whose profile is cooling
// after a provider limit is refused (profile routing): it could neither
// interrupt usefully nor run.
import type { ChatSessionRecord } from '../db'
import { loadGroupCatalog } from './groupCatalog'
import { loadTeamGroups } from './teamGroups'
import { resolveTeam, type TeamIdentity } from './teamIdentity'
import { MailboxStore, type TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'

/** Who is sending: an agent session (identity bound) or the human for a team. */
export type MailCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export interface MailInput {
  /**
   * Routing vocabulary (D4). `human` is accepted so the refusal can teach the
   * reply path — neither agent nor human may *start* mail to the human.
   */
  to_kind: 'group' | 'session' | 'human'
  /** Recipient id; absent for `to_kind: 'human'`. */
  to_id?: string | null
  body: string
  urgent?: boolean
  tags?: string[]
  task_id?: string
}

export interface MailReplyInput {
  message_id: string
  body: string
  urgent?: boolean
  tags?: string[]
  task_id?: string
}

const START_TO_HUMAN = 'New mail to the human is not a thing. Reply to a message they sent instead — that reply reaches them.'

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

  /** The sender's team, catalog, and the identity the row is stamped with. */
  private async context(caller: MailCaller) {
    if (caller.kind === 'human') {
      const catalog = loadGroupCatalog({
        groupsRoot: caller.team.groupsRoot, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
      })
      return {
        team: caller.team, catalog,
        fromKind: 'human' as const, fromSession: null, fromGroup: null,
        originPath: caller.team.groupsRoot, hopLimit: undefined,
      }
    }
    const sender = this.options.getSession(caller.sessionId)
    if (!sender) throw new Error(`Unknown sending session: ${caller.sessionId}`)
    const { team, catalog } = await loadTeamGroups(sender.projectPath, this.options.homeDir)
    return {
      team, catalog,
      fromKind: 'agent' as const, fromSession: sender.sessionId, fromGroup: sender.groupId ?? null,
      originPath: sender.projectPath,
      hopLimit: sender.groupId ? catalog.groups.get(sender.groupId)?.group?.hopLimit : undefined,
    }
  }

  async listGroups(caller: MailCaller) {
    const { catalog } = await this.context(caller)
    return [...catalog.groups.values()].map(({ group: { id, label, description } }) => ({ id, label, description }))
  }

  async send(caller: MailCaller, input: MailInput, deliverAt?: string): Promise<TeamMessage> {
    const sender = await this.context(caller)
    const taskId = this.taskOf(sender.team, input.task_id)
    const target = this.targetOf(sender, input)
    if (target.kind === 'session') {
      const recipient = target.recipient
      if ((await resolveTeam(recipient.projectPath)).teamId !== sender.team.teamId) {
        throw new Error('Recipient belongs to another team')
      }
      this.refuseCooling(recipient, input.urgent)
      // Direct mail resumes an archived recipient, exactly as replies do:
      // otherwise the message could queue forever behind a parked session.
      if (recipient.archivedAt) await this.options.restoreSession?.(recipient.sessionId)
    }
    return this.publish(this.store.enqueue({
      teamId: sender.team.teamId, toKind: target.kind, toId: target.id,
      fromKind: sender.fromKind, fromSession: sender.fromSession, fromGroup: sender.fromGroup,
      originPath: sender.originPath, body: input.body,
      priority: input.urgent ? 'urgent' : 'normal', tags: input.tags,
      hopLimit: sender.hopLimit, deliverAt, taskId,
    }))
  }

  async schedule(caller: MailCaller, input: MailInput & { deliver_at?: string; delay_seconds?: number }) {
    if ((input.deliver_at === undefined) === (input.delay_seconds === undefined)) {
      throw new Error('Provide exactly one of deliver_at or delay_seconds')
    }
    const due = input.deliver_at === undefined
      ? Date.now() + input.delay_seconds! * 1000 : Date.parse(input.deliver_at)
    if (!Number.isFinite(due) || (input.delay_seconds !== undefined && input.delay_seconds < 0)) {
      throw new Error('Invalid scheduled delivery time')
    }
    return this.send(caller, input, new Date(due).toISOString())
  }

  async reply(caller: MailCaller, input: MailReplyInput) {
    const sender = await this.context(caller)
    const explicitTask = this.taskOf(sender.team, input.task_id)
    const original = this.store.get(input.message_id)
    if (!original || original.teamId !== sender.team.teamId) {
      throw new Error('Can only reply to a message of this team')
    }
    // An agent answers only mail it actually received; the human sees the
    // team's threads and may answer any of them.
    if (caller.kind === 'agent' && (original.claimedBy !== caller.sessionId || original.deliveredAt === null)) {
      throw new Error('Can only reply to a message received by this session')
    }
    // A human sender has no session to claim or push the reply (D5): it is
    // addressed to the human and settled on send. Never a "killed sender".
    const toHuman = original.fromKind === 'human' || original.fromSession === null
    const recipient = toHuman ? null
      : original.fromSession ? this.options.getSession(original.fromSession) : null
    if (recipient && (await resolveTeam(recipient.projectPath)).teamId !== sender.team.teamId) {
      throw new Error('Recipient belongs to another team')
    }
    if (recipient) this.refuseCooling(recipient, input.urgent)
    if (recipient?.archivedAt) await this.options.restoreSession?.(recipient.sessionId)
    const fallback = !toHuman && !recipient && original.fromGroup !== null
    const message = this.store.enqueue({
      teamId: sender.team.teamId,
      toKind: toHuman ? 'human' : fallback ? 'group' : 'session',
      toId: toHuman ? null : fallback ? original.fromGroup : original.fromSession,
      fromKind: sender.fromKind, fromSession: sender.fromSession, fromGroup: sender.fromGroup,
      originPath: sender.originPath, body: input.body,
      priority: input.urgent ? 'urgent' : 'normal', tags: input.tags,
      inReplyTo: original, attachThread: fallback,
      taskId: explicitTask ?? original.taskId,
      hopLimit: sender.hopLimit,
    })
    if (toHuman) {
      const task = message.taskId ? this.options.tasks?.get(message.taskId) : null
      this.store.deliverOnSend(message.id, task?.revision ?? null)
    } else if (!recipient && (!fallback || !sender.catalog.groups.has(original.fromGroup!))) {
      this.store.deadLetter(message.id, 'killed-sender-without-group')
    }
    return this.publish(this.store.get(message.id)!)
  }

  /**
   * Resolve a send's recipient. `human` is never a valid *start* — only a
   * reply in a human-started thread may target them (D5).
   */
  private targetOf(sender: Awaited<ReturnType<TeamMailbox['context']>>, input: MailInput) {
    if (input.to_kind === 'human') throw new Error(START_TO_HUMAN)
    const id = input.to_id?.trim()
    if (!id) throw new Error(`A ${input.to_kind} recipient needs an id`)
    if (input.to_kind === 'group') {
      if (!sender.catalog.groups.has(id)) throw new Error(`Unknown group: ${id}`)
      return { kind: 'group' as const, id }
    }
    const recipient = this.options.getSession(id)
    if (!recipient) throw new Error(`Unknown recipient session: ${id}`)
    return { kind: 'session' as const, id, recipient }
  }

  private publish(message: TeamMessage) {
    this.options.onChange?.(message)
    return message
  }
}
