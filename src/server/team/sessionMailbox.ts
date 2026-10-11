// Chat lifecycle adapter for team mail. Recipient snapshots share one catalog
// per team/cycle; receipt recovery runs before watchers or records are released.
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
import type { Database } from 'bun:sqlite'

export class SessionMailbox {
  readonly mailbox: TeamMailbox
  readonly tasks: TaskService
  readonly dispatcher: MailDispatcher
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
    transcriptFor: (id: string) => string | null
    homeDir?: string
    onChange?: (team: string, message?: TeamMessage) => void
    onError: (error: unknown) => void
  }) {
    const store = new MailboxStore(db, { recipientExists: id => !!options.getRecord(id) })
    this.tasks = new TaskService(new TaskStore(db, store), { getSession: options.getRecord, homeDir: options.homeDir })
    this.mailbox = new TeamMailbox(store, {
      getSession: options.getRecord, homeDir: options.homeDir, restoreSession: options.restore,
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
    }
  }

  /** Start only after persisted chat records are restored. */
  start() {
    const store = this.mailbox.store
    reconcileMailbox(store, this.options.transcriptFor)
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
