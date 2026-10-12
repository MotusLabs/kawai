// Chat lifecycle adapter for team mail. Recipient snapshots share one catalog
// per team/cycle; receipt recovery runs before watchers or records are released.
// Team tasks (task store/service) and worktree staffing are wired here too:
// recipients carry their resolved worktree, task mail is routed by its
// task's target, and the staffing pass spawns through the manager. Profile
// limit events (profile routing) are recorded here for routing to read.
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
import { LimitEventStore } from './routing/limitEvents'
import { RuleRegistry, type RuleLoadReport } from './routing/ruleLoader'
import { ProfileRouter } from './routing/router'
import { LimitOutcomes, type HandoffTarget } from './routing/limitOutcomes'
import { loadTeamGroups } from './teamGroups'
import type { ChatUsageReport } from '../../shared/chat'
import type { RouteDecisionLogEntry } from '../../shared/routing'
import type { Database } from 'bun:sqlite'

export class SessionMailbox {
  readonly mailbox: TeamMailbox
  readonly tasks: TaskService
  readonly dispatcher: MailDispatcher
  readonly staffing: WorktreeStaffing
  readonly limits: LimitEventStore
  readonly rules: RuleRegistry
  readonly router: ProfileRouter
  readonly outcomes: LimitOutcomes
  private readonly catalogs = new Map<string, GroupCatalog>()
  private releaseSubscription?: () => void
  private releaseLimitSubscription?: () => void

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
    /** Routing rules finished loading (start or reload). */
    onRulesLoaded?: (report: RuleLoadReport) => void
    /** A profile's latest plan usage, for routing rules. */
    usageOf?: (profileId: string) => ChatUsageReport | null
    /** A routing decision was made (mailbox view). */
    onRouteDecision?: (entry: RouteDecisionLogEntry) => void
    onError: (error: unknown) => void
  }) {
    const store = new MailboxStore(db, { recipientExists: id => !!options.getRecord(id) })
    this.limits = new LimitEventStore(db)
    this.rules = new RuleRegistry({
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      onLoaded: report => {
        this.router.invalidateHolds()
        options.onRulesLoaded?.(report)
        this.dispatcher.notify()
      },
    })
    const taskStore = new TaskStore(db, store)
    this.tasks = new TaskService(taskStore, { getSession: options.getRecord, homeDir: options.homeDir })
    this.mailbox = new TeamMailbox(store, {
      getSession: options.getRecord, homeDir: options.homeDir, restoreSession: options.restore, tasks: taskStore,
      cooldownUntil: profileId => this.limits.cooldownUntil(profileId),
    })
    this.staffing = new WorktreeStaffing(db, store, {
      records: options.records,
      teamOf: id => options.teams.teamOf(id),
      caps: options.caps ?? new TeamCaps({ homeDir: options.homeDir }),
      worktrees: this.tasks.worktrees,
      spawn: request => options.spawn ? options.spawn(request) : Promise.resolve({ ok: false, error: 'Spawning is not available' }),
      onError: options.onError,
    })
    const targetWorktree = (message: TeamMessage) => (message.taskId ? taskStore.get(message.taskId)?.worktree ?? null : null)
    this.router = new ProfileRouter({
      // Read through a live team member's cached catalog (one read per team
      // per cycle); with no live member, resolve from the message's origin.
      groupOf: async message => {
        const records = [...options.records()]
        const peer = records.find(record => record.sessionId === message.fromSession && options.teams.teamOf(record.sessionId)?.teamId === message.teamId) ??
          records.find(record => options.teams.teamOf(record.sessionId)?.teamId === message.teamId)
        if (peer) return options.teams.catalogOf(peer.sessionId, this.catalogs)?.groups.get(message.toId)
        const { team, catalog } = await loadTeamGroups(message.originPath, options.homeDir)
        return team.teamId === message.teamId ? catalog.groups.get(message.toId) : undefined
      },
      members: (teamId, groupId) => [...options.records()].flatMap(record =>
        record.archivedAt == null && record.groupId === groupId && options.teams.teamOf(record.sessionId)?.teamId === teamId
          ? [{ sessionId: record.sessionId, profileId: record.claudeProfileId ?? 'default', cwd: record.projectPath }]
          : []),
      targetWorktree,
      staffing: this.staffing,
      rules: this.rules,
      limits: this.limits,
      usageOf: profileId => options.usageOf?.(profileId) ?? null,
      excludedProfile: message => message.excludedProfile ?? undefined,
      ...(options.onRouteDecision ? { onDecision: options.onRouteDecision } : {}),
    })
    this.outcomes = new LimitOutcomes(db, {
      store, limits: this.limits, rules: this.rules,
      getRecord: options.getRecord,
      teamOf: id => options.teams.teamOf(id)?.teamId,
      groupOf: (sessionId, groupId) => options.teams.catalogOf(sessionId, this.catalogs)?.groups.get(groupId),
      taskTitle: taskId => taskStore.get(taskId)?.title ?? null,
      targetWorktree, restoreSession: options.restore,
      onError: options.onError,
    })
    this.dispatcher = new MailDispatcher(this.mailbox.store, {
      beginCycle: () => { this.catalogs.clear(); this.outcomes.processNotes() },
      claimed: (message, id) => this.outcomes.claimed(message, id),
      delivered: (id, message) => this.outcomes.delivered(id, message),
      wakeAt: () => this.outcomes.nextNoteAt(),
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
      targetWorktree,
      router: this.router,
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
      parked: this.mailbox.store.parkedBy(id).length > 0,
      profileId: record.claudeProfileId ?? 'default',
      cooldownUntil: this.limits.cooldownUntil(record.claudeProfileId ?? 'default'),
    }
  }

  /** A tool call in a session's transcript (limit progress). */
  toolCall(sessionId: string, tool: string, input: unknown) {
    this.outcomes.toolCall(sessionId, tool, input)
  }

  /** A session's turn ended; its mail was settled first. */
  turnEnded(sessionId: string, success: boolean) {
    void this.outcomes.turnEnded(sessionId, success).then(() => this.dispatcher.notify(), this.options.onError)
  }

  /** The human hands parked work to a group or session. */
  handOff(messageId: string, target: HandoffTarget) {
    const forwarded = this.outcomes.handOff(messageId, target)
    this.dispatcher.notify()
    return forwarded
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
    this.releaseLimitSubscription = this.limits.subscribe(() => this.dispatcher.notify())
    this.dispatcher.notify()
    // Rules load once at start; afterwards only an explicit reload changes them.
    void this.rules.reload().then(() => this.dispatcher.notify(), this.options.onError)
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

  close() { this.dispatcher.close(); this.releaseSubscription?.(); this.releaseLimitSubscription?.(); this.rules.close() }
}
