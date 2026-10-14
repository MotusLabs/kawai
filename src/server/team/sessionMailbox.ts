// Chat lifecycle adapter for team mail. Recipient snapshots share one catalog
// per team/cycle; receipt recovery runs before watchers or records are released.
// Team tasks (task store/service) and worktree staffing are wired here too:
// recipients carry their resolved worktree, task mail is routed by its
// task's target, and the staffing pass spawns through the manager. Profile
// limit events (profile routing) are recorded here for routing to read.
// Waiting reasons (team-waiting-reasons D3/D5): the per-team reason ledger
// lives here, fed by the dispatcher's afterPass outcome and the spawn
// failure backoff, published when it structurally changes; the failed-spawn
// backoff's end folds into the dispatcher's wake time.
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '../../shared/team'
import type { GroupCatalog } from './groupCatalog'
import type { GroupDefinition } from './groupFile'
import type { PendingSpawnRow } from './teamRoster'
import { SessionTeams } from './sessionTeams'
import { TeamMailbox } from './TeamMailbox'
import { MailboxStore } from './mailboxStore'
import { MailDispatcher, type MailRecipient, type PassOutcome } from './dispatcher'
import { reconcileMailbox, transcriptReceipt } from './receipt'
import { TaskStore } from './taskStore'
import { TaskService } from './TaskService'
import { MemberRelease, type ArchiveResult } from './memberRelease'
import { MailboxManagement } from './mailboxManagement'
import { AssignmentStore } from './assignmentStore'
import { AssignmentService } from './AssignmentService'
import { TaskResultService } from './TaskResultService'
import { buildTaskContext } from './taskContext'
import { WorktreeStaffing, type SpawnRequest, type SpawnResult } from './staffing'
import { TeamCaps } from './teamCaps'
import { worktreeRootOf } from './worktreeRoots'
import { LimitEventStore } from './routing/limitEvents'
import { RuleRegistry, type RuleLoadReport } from './routing/ruleLoader'
import { ProfileRouter } from './routing/router'
import { LimitOutcomes, type HandoffTarget } from './routing/limitOutcomes'
import { ReasonLedger, orderConstraints, toReason } from './waitingReasons'
import { loadTeamGroups } from './teamGroups'
import type { ChatUsageReport } from '../../shared/chat'
import type { RouteDecisionLogEntry } from '../../shared/routing'
import type { Database } from 'bun:sqlite'

export class SessionMailbox {
  readonly mailbox: TeamMailbox
  readonly tasks: TaskService
  readonly management: MailboxManagement
  readonly assignments: AssignmentService
  /** Results, findings, acceptance, handoffs, and release-and-hand-off (task-results-handoffs). */
  readonly results: TaskResultService
  readonly dispatcher: MailDispatcher
  readonly staffing: WorktreeStaffing
  readonly limits: LimitEventStore
  readonly rules: RuleRegistry
  readonly router: ProfileRouter
  readonly outcomes: LimitOutcomes
  /** Pending member releases (member-release); the release tool and task-close hook. */
  readonly releases: MemberRelease
  /** Per-team waiting reasons (D3): in-memory, rebuilt by the first pass. */
  private readonly reasons = new ReasonLedger()
  private readonly catalogs = new Map<string, GroupCatalog>()
  private releaseSubscription?: () => void
  private releaseLimitSubscription?: () => void
  private releaseTaskSubscription?: () => void

  constructor(db: Database, private readonly options: {
    teams: SessionTeams
    records: () => Iterable<ChatSessionRecord>
    getRecord: (id: string) => ChatSessionRecord | undefined
    getDriver: (id: string) => ChatSessionDriver | undefined
    available: (record: ChatSessionRecord) => boolean
    /** The manager's start refusal text for the unavailable reason (D2); `available` keeps deciding. */
    startBlocker?: (record: ChatSessionRecord) => string | null
    prepare: (id: string) => Promise<void>
    restore: (id: string) => void
    watchReceipt: (id: string) => void
    /** Archive a session the safe way (member-release D2: release = archive). */
    archive: (id: string) => ArchiveResult
    /** Whether the session has a live background worker (member-release D3). */
    hasLiveWorkers: (id: string) => boolean
    /** Whether the session has a running background task (member-release D3). */
    hasRunningBackgroundTasks: (id: string) => boolean
    /** The session received mail under this task (its header shows it). */
    associateTask?: (id: string, taskId: string) => void
    /** Create a group member in a worktree for staffing (team-tasks D4). */
    spawn?: (request: SpawnRequest) => Promise<SpawnResult>
    /** Spawn-failure backoff (D5); tests shorten it to watch a retry run. */
    spawnRetryAfterMs?: number
    /** Clock for the waiting-reason derivation; tests inject their own. */
    now?: () => number
    /** User-level team caps; tests inject their own home. */
    caps?: TeamCaps
    transcriptFor: (id: string) => string | null
    homeDir?: string
    onChange?: (team: string, message?: TeamMessage) => void
    /** A team's waiting reasons structurally changed: re-publish its snapshot (D3). */
    onReasonsChange?: (team: string) => void
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
    const caps = options.caps ?? new TeamCaps({ homeDir: options.homeDir })
    // The assignment store rides the mailbox (claim copies follow the mail)
    // and feeds the task summaries beside the derived participants.
    const assignments = new AssignmentStore(db, store)
    const taskStore = new TaskStore(db, store, assignments)
    // Pending member releases (member-release D1/D2): durable rows the close
    // writes, evaluated inside the dispatch cycle before routing.
    this.releases = new MemberRelease(db, {
      store, tasks: taskStore,
      records: options.records,
      getRecord: options.getRecord,
      teamOf: id => options.teams.teamOf(id),
      definition: (teamId, groupId, originPath) => this.groupDefinition(teamId, groupId, originPath),
      cachedDefinition: (teamId, groupId) => this.catalogs.get(teamId)?.groups.get(groupId),
      recipient: id => this.recipient(id),
      hasLiveWorkers: options.hasLiveWorkers,
      hasRunningBackgroundTasks: options.hasRunningBackgroundTasks,
      archive: options.archive,
      notify: () => this.dispatcher.notify(),
    })
    this.tasks = new TaskService(taskStore, {
      getSession: options.getRecord, homeDir: options.homeDir,
      onStatusTransition: (task, status, actor) => this.releases.transitionHook(task, status, actor),
      restoreSession: options.restore,
    })
    this.management = new MailboxManagement(store, {
      getSession: options.getRecord, tasks: this.tasks, homeDir: options.homeDir,
      waitingFor: teamId => this.waitingFor(teamId), ...(options.now ? { now: options.now } : {}),
    })
    this.mailbox = new TeamMailbox(store, {
      getSession: options.getRecord, homeDir: options.homeDir, restoreSession: options.restore, tasks: taskStore,
      cooldownUntil: profileId => this.limits.cooldownUntil(profileId),
    })
    this.staffing = new WorktreeStaffing(db, store, {
      records: options.records,
      teamOf: id => options.teams.teamOf(id),
      caps,
      worktrees: this.tasks.worktrees,
      spawn: request => options.spawn ? options.spawn(request) : Promise.resolve({ ok: false, error: 'Spawning is not available' }),
      ...(options.spawnRetryAfterMs !== undefined ? { retryAfterMs: options.spawnRetryAfterMs } : {}),
      // Recorded before the requeue notify publishes (D3), so the failure
      // snapshot already carries the backoff reason with its retry time.
      onSpawnBackoff: (message, retryAt) => {
        if (this.reasons.set(message.teamId, message.id, toReason([{ kind: 'spawn-backoff', retryAt: new Date(retryAt).toISOString() }]))) {
          this.options.onReasonsChange?.(message.teamId)
        }
      },
      onError: options.onError,
    })
    this.assignments = new AssignmentService(db, assignments, taskStore, store, {
      getSession: options.getRecord,
      records: options.records,
      teamOf: id => options.teams.teamOf(id),
      staffing: this.staffing,
      caps,
      worktrees: this.tasks.worktrees,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      cooldownUntil: profileId => this.limits.cooldownUntil(profileId),
    })
    this.results = new TaskResultService(this.tasks, { getSession: options.getRecord })
    // Worktree scoping (member-release D5): an unscoped group's task mail goes
    // to any member and never spawns; a missing definition stays scoped.
    const targetWorktree = (message: TeamMessage): string | null => {
      const worktree = message.taskId ? taskStore.get(message.taskId)?.worktree ?? null : null
      if (worktree === null || message.toKind !== 'group' || message.toId === null) return worktree
      return this.catalogs.get(message.teamId)?.groups.get(message.toId)?.worktreeScoped === false ? null : worktree
    }
    this.router = new ProfileRouter({
      // Read through a live team member's cached catalog (one read per team
      // per cycle); with no live member, resolve from the message's origin.
      groupOf: async message => {
        // Routing only ever asks about group mail; a null target is not a group.
        if (message.toId === null) return undefined
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
      // Cycle start (member-release D5): clear the catalog cache, keep the
      // limit-recovery notes flowing, seed this cycle's group definitions,
      // then run the release pass — all awaited before routing.
      beginCycle: async () => {
        this.catalogs.clear()
        this.outcomes.processNotes()
        await this.loadCycleDefinitions()
        await this.releases.evaluate()
      },
      claimed: (message, id) => this.outcomes.claimed(message, id),
      delivered: (id, message) => this.outcomes.delivered(id, message),
      // Recovery notes and failed-spawn backoffs share the minimum-wins timer (D5).
      wakeAt: () => {
        const note = this.outcomes.nextNoteAt()
        const retry = this.staffing.nextRetryAt()
        return note !== null && (retry === null || note < retry) ? note : retry
      },
      afterPass: outcome => this.applyReasons(outcome),
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
      // Nothing dispatches before start(): receipt recovery and the
      // killed-recipient sweep need every restored record first.
      held: true,
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
      blockedBy: this.options.startBlocker?.(record) ?? null,
      worktree: worktreeRootOf(record.projectPath),
      parked: this.mailbox.store.parkedBy(id).length > 0,
      profileId: record.claudeProfileId ?? 'default',
      cooldownUntil: this.limits.cooldownUntil(record.claudeProfileId ?? 'default'),
    }
  }

  /** The team's worktree occupancy read model (mailbox snapshot, D4). */
  roster(teamId: string) { return this.staffing.roster(teamId) }

  /**
   * Pass end (D3): merge the pass's diagnoses into the ledger, drop entries
   * (and spawn backoffs) for messages that left the waiting surface, and
   * re-publish a team's snapshot when its reasons structurally changed —
   * the cases where no row state changed and nothing else would publish.
   */
  private applyReasons(outcome: PassOutcome) {
    const changedTeams = this.reasons.prune(outcome.waiting)
    // A backoff whose message left the waiting surface is dead: the timer
    // re-reads nextRetryAt on every re-arm and must never arm on it (D5).
    this.staffing.pruneBackoffs(outcome.waiting)
    for (const [id, constraints] of outcome.reasons) {
      const row = this.mailbox.store.get(id)
      if (!row) continue
      if (this.reasons.set(row.teamId, id, toReason(constraints))) changedTeams.add(row.teamId)
    }
    for (const teamId of changedTeams) this.options.onReasonsChange?.(teamId)
  }

  /**
   * The team's waiting reasons for the mailbox snapshot (D3): ledger entries
   * for queued-due and awaiting-request rows, live derivation for `spawning`
   * rows (they leave the state inside one awaited pass, so no pass-end hook
   * can diagnose them — the reservation row is the source).
   */
  waitingFor(teamId: string): Record<string, WaitingReason> {
    const out: Record<string, WaitingReason> = {}
    const ledger = this.reasons.forTeam(teamId)
    const pending = new Map(this.staffing.pendingFor(teamId).map(row => [row.messageId, row]))
    const now = this.options.now?.() ?? Date.now()
    for (const row of this.mailbox.store.listForTeam(teamId)) {
      if (row.state === 'spawning') {
        out[row.id] = this.startingAgentReason(teamId, row, pending.get(row.id) ?? null)
        continue
      }
      const due = row.state === 'awaiting-request' ||
        (row.state === 'queued' && (row.deliverAt === null || Date.parse(row.deliverAt) <= now))
      if (due && ledger[row.id]) out[row.id] = ledger[row.id]!
    }
    return out
  }

  /**
   * A `spawning` row's reason (D1/D3): Starting agent is always the blocker
   * — its own reservation fills caps and holds the worktree, so those facts
   * it creates itself sit among the other constraints, and an independent
   * occupant is named there.
   */
  private startingAgentReason(teamId: string, row: TeamMessage, reservation: PendingSpawnRow | null): WaitingReason {
    const blocker: WaitingConstraint = {
      kind: 'starting-agent',
      ...(reservation ? { reservation: {
        group: reservation.groupId, profile: reservation.profileId,
        worktree: reservation.worktree, startedAt: reservation.createdAt,
      } } : {}),
    }
    const others: WaitingConstraint[] = []
    if (reservation && row.toId !== null) {
      const group = this.groupOfTeam(teamId, row.toId)
      const capacity = this.staffing.capacity(teamId, row.toId, reservation.worktree, row.id)
      if (group && capacity.groupMembers >= group.max) {
        others.push({ kind: 'group-cap', counts: { live: capacity.groupMembers, cap: group.max } })
      }
      for (const entry of group?.profiles ?? []) {
        const live = capacity.onProfile[entry.profileId] ?? 0
        if (entry.cap !== undefined && live >= entry.cap) {
          others.push({ kind: 'profile-cap', counts: { live, cap: entry.cap }, detail: entry.profileId })
        }
      }
      if (capacity.teamSpawned >= capacity.teamCap) {
        others.push({ kind: 'team-spawn-cap', counts: { live: capacity.teamSpawned, cap: capacity.teamCap } })
      }
      // Its own pending reservation holds the writer slot; independent
      // occupants (spawned members, other reservations) are named.
      const live = capacity.worktreeOccupants.length + capacity.worktreePending + 1
      others.push({
        kind: 'worktree-occupied', counts: { live, cap: 1 },
        ...(capacity.worktreeOccupants.length > 0 ? { sessionIds: capacity.worktreeOccupants } : {}),
        detail: reservation.worktree,
      })
    }
    return { blocker, others: orderConstraints(others) }
  }

  /** The group definition from a live member's cached catalog, when one exists. */
  private groupOfTeam(teamId: string, groupId: string): GroupDefinition | undefined {
    for (const record of this.options.records()) {
      if (this.options.teams.teamOf(record.sessionId)?.teamId !== teamId) continue
      return this.options.teams.catalogOf(record.sessionId, this.catalogs)?.groups.get(groupId)
    }
    return undefined
  }

  /**
   * A group's definition from the current file (member-release D5): a live
   * team member's stamp-validated catalog first, else the mail's origin —
   * so a group with no live member still resolves for the close transition
   * and the release tool.
   */
  private async groupDefinition(teamId: string, groupId: string, originPath?: string): Promise<GroupDefinition | undefined> {
    for (const record of this.options.records()) {
      if (this.options.teams.teamOf(record.sessionId)?.teamId !== teamId) continue
      return this.options.teams.catalogOf(record.sessionId, this.catalogs)?.groups.get(groupId)
    }
    if (!originPath) return undefined
    const { team, catalog } = await loadTeamGroups(originPath, this.options.homeDir)
    return team.teamId === teamId ? catalog.groups.get(groupId) : undefined
  }

  /**
   * Seed this cycle's catalogs (member-release D5): every team with waiting
   * group mail or a pending release gets its definitions resolved before
   * `targetWorktree`, release evaluation, or routing reads them.
   */
  private async loadCycleDefinitions(): Promise<void> {
    const teams = new Set<string>()
    const origins = new Map<string, string>()
    for (const message of this.mailbox.store.waitingRows()) {
      if (message.toKind !== 'group' || message.toId === null) continue
      teams.add(message.teamId)
      origins.set(message.teamId, message.originPath)
    }
    // A pending member's own path resolves its team when nothing else does,
    // so the release pass always reads the group's current opt-out (D1).
    for (const row of this.releases.pending()) {
      teams.add(row.teamId)
      const member = this.options.getRecord(row.sessionId)
      if (member && !origins.has(row.teamId)) origins.set(row.teamId, member.projectPath)
    }
    for (const teamId of teams) {
      if (this.catalogs.has(teamId)) continue
      const member = [...this.options.records()].find(record => this.options.teams.teamOf(record.sessionId)?.teamId === teamId)
      if (member) { this.options.teams.catalogOf(member.sessionId, this.catalogs); continue }
      const origin = origins.get(teamId)
      if (!origin) continue
      const { team, catalog } = await loadTeamGroups(origin, this.options.homeDir)
      if (team.teamId === teamId) this.catalogs.set(teamId, catalog)
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

  /** Start only after persisted chat records are restored; dispatch is held until then. */
  start() {
    const store = this.mailbox.store
    reconcileMailbox(store, this.options.transcriptFor)
    this.staffing.reconcile()
    for (const team of store.teamsWithQueuedMail()) {
      for (const mail of store.listForTeam(team)) {
        if (mail.toKind === 'session' && mail.toId !== null && !this.options.getRecord(mail.toId)) store.deadLetter(mail.id, 'killed-recipient')
      }
    }
    this.releaseSubscription = store.subscribe((team, message) => {
      this.options.onChange?.(team, message)
      this.dispatcher.notify()
    })
    this.releaseLimitSubscription = this.limits.subscribe(() => this.dispatcher.notify())
    // A task close marks pending releases and dead-letters mail (D2): the
    // next cycle evaluates them.
    this.releaseTaskSubscription = this.tasks.store.subscribe(() => this.dispatcher.notify())
    this.dispatcher.release()
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

  /** A session was archived, killed, or restored: its pending release is moot (D1). */
  cancelPendingRelease(id: string) {
    this.releases.cancel(id)
  }

  /** A spawned session was created for an already-closed task (D1): mark it pending release, retrying on failure. */
  markSpawnedForClosedTask(id: string, taskId: string) {
    this.releases.markLateSpawn(id, taskId)
  }

  close() { this.dispatcher.close(); this.releases.close(); this.releaseSubscription?.(); this.releaseLimitSubscription?.(); this.releaseTaskSubscription?.(); this.rules.close() }
}
