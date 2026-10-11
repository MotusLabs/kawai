// Chat lifecycle adapter for team mail. Recipient snapshots share one catalog
// per team/cycle; receipt recovery runs before watchers or records are released.
// Team tasks (task store/service) and worktree staffing are wired here too:
// recipients carry their resolved worktree, task mail is routed by its
// task's target, and the staffing pass spawns through the manager.
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import type { TeamMessage } from '../../shared/team'
import type { GroupCatalog } from './groupCatalog'
import { SessionTeams } from './sessionTeams'
import { TeamMailbox } from './TeamMailbox'
import { MailboxStore } from './mailboxStore'
import { MailDispatcher, type MailRecipient } from './dispatcher'
import { reconcileMailbox, transcriptReceipt } from './receipt'
import { TaskStore } from './taskStore'
import { TaskService } from './TaskService'
import { buildTaskContext } from './taskContext'
import { WorktreeStaffing, type SpawnRequest, type SpawnResult } from './staffing'
import { TeamCaps } from './teamCaps'
import { worktreeRootOf } from './worktreeRoots'
import type { Database } from 'bun:sqlite'

export class SessionMailbox {
  readonly mailbox: TeamMailbox
  readonly tasks: TaskService
  readonly dispatcher: MailDispatcher
  readonly staffing: WorktreeStaffing
  private readonly catalogs = new Map<string, GroupCatalog>()
  private releaseSubscription?: () => void

  constructor(db: Database, private readonly options: {
    teams: SessionTeams
    records: () => Iterable<ChatSessionRecord>
    getRecord: (id: string) => ChatSessionRecord | undefined
    getDriver: (id: string) => ChatSessionDriver | undefined
    available: (record: ChatSessionRecord) => boolean
    prepare: (id: string) => Promise<void>
    restore: (id: string) => void
    watchReceipt: (id: string) => void
    /** The session received mail under this task (its header shows it). */
    associateTask?: (id: string, taskId: string) => void
    /** Create a group member in a worktree for staffing (team-tasks D4). */
    spawn?: (request: SpawnRequest) => Promise<SpawnResult>
    /** User-level team caps; tests inject their own home. */
    caps?: TeamCaps
    transcriptFor: (id: string) => string | null
    homeDir?: string
    onChange?: (team: string, message?: TeamMessage) => void
    onError: (error: unknown) => void
  }) {
    const store = new MailboxStore(db, { recipientExists: id => !!options.getRecord(id) })
    const taskStore = new TaskStore(db, store)
    this.tasks = new TaskService(taskStore, { getSession: options.getRecord, homeDir: options.homeDir })
    this.mailbox = new TeamMailbox(store, {
      getSession: options.getRecord, homeDir: options.homeDir, restoreSession: options.restore, tasks: taskStore,
    })
    this.staffing = new WorktreeStaffing(db, store, {
      records: options.records,
      teamOf: id => options.teams.teamOf(id),
      hasIdleMember: (teamId, groupId, worktree) => [...options.records()].some(record => {
        const recipient = this.recipient(record.sessionId)
        return !!recipient && recipient.teamId === teamId && recipient.groupId === groupId && recipient.worktree === worktree &&
          recipient.idle && recipient.available && !recipient.pendingRequest
      }),
      caps: options.caps ?? new TeamCaps({ homeDir: options.homeDir }),
      worktrees: this.tasks.worktrees,
      spawn: request => options.spawn ? options.spawn(request) : Promise.resolve({ ok: false, error: 'Spawning is not available' }),
      homeDir: options.homeDir,
      onError: options.onError,
    })
    this.dispatcher = new MailDispatcher(this.mailbox.store, {
      beginCycle: () => this.catalogs.clear(),
      recipients: () => [...options.records()].flatMap(record => {
        const recipient = this.recipient(record.sessionId)
        return recipient ? [recipient] : []
      }),
      recipient: id => this.recipient(id),
      prepare: options.prepare,
      interrupt: async id => { await options.getDriver(id)?.interrupt() },
      deliver: (id, envelope) => {
        const driver = options.getDriver(id)
        if (!driver) throw new Error('Recipient disappeared')
        driver.deliver(envelope)
      },
      taskContext: taskId => buildTaskContext(taskStore, taskId),
      targetWorktree: message => (message.taskId ? taskStore.get(message.taskId)?.worktree ?? null : null),
      staff: () => this.staffing.run(),
      associateTask: (id, taskId) => options.associateTask?.(id, taskId),
      watchReceipt: mail => {
        if (!mail.claimedBy) return
        if (!options.getRecord(mail.claimedBy) || this.mailbox.store.get(mail.id)?.state === 'uncertain') this.settle(mail)
        if (options.getRecord(mail.claimedBy)) options.watchReceipt(mail.claimedBy)
      },
      onError: options.onError,
    })
  }

  private recipient(id: string): MailRecipient | undefined {
    const record = this.options.getRecord(id)
    const team = this.options.teams.teamOf(id)
    if (!record || !team) return
    return {
      sessionId: id, teamId: team.teamId,
      groupId: record.groupId && !this.options.teams.groupInfo(id, record.groupId, this.catalogs)?.missing ? record.groupId : null,
      idle: record.status === 'waiting',
      pendingRequest: (this.options.getDriver(id)?.getPendingRequests().length ?? 0) > 0,
      available: this.options.available(record),
      worktree: worktreeRootOf(record.projectPath),
    }
  }

  /** Start only after persisted chat records are restored. */
  start() {
    const store = this.mailbox.store
    reconcileMailbox(store, this.options.transcriptFor)
    this.staffing.reconcile()
    for (const team of store.teamsWithQueuedMail()) {
      for (const mail of store.listForTeam(team)) {
        if (mail.toKind === 'session' && !this.options.getRecord(mail.toId)) store.deadLetter(mail.id, 'killed-recipient')
      }
    }
    this.releaseSubscription = store.subscribe((team, message) => {
      this.options.onChange?.(team, message)
      this.dispatcher.notify()
    })
    this.dispatcher.notify()
  }

  private settle(mail: TeamMessage) {
    const store = this.mailbox.store
    if (mail.claimedBy && transcriptReceipt(this.options.transcriptFor(mail.claimedBy), mail.id) === 'found') store.markDelivered(mail.id)
    else store.holdUncertain(mail.id, 'receipt-unconfirmed-after-delivery')
  }

  /** Live CLI input may still be draining: absence cannot authorize requeue. */
  settleRecipient(id: string) {
    for (const mail of this.mailbox.store.claimsFor(id)) {
      if (mail.pushedAt) this.settle(mail)
      else this.mailbox.store.requeue(mail.id)
    }
  }

  close() { this.dispatcher.close(); this.releaseSubscription?.() }
}
