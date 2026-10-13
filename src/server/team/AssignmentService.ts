// Assignment operations (task-assignment design D3/D4/D6/D7/D8): dispatch an
// instruction to a group or a session as the human, idempotently under a
// client request key; reassign explicitly (supersede, cancel-on-stop, notify);
// preview a dispatch read-only from the same sources the dispatcher uses; and
// list the team-scoped worktree/change targets the pickers offer.
//
// Dispatch is one SQLite transaction: the assignment row and its instruction
// mail commit together (or not at all), so an accepted dispatch always has its
// mail and a refusal writes nothing. The instruction is an ordinary
// `team_messages` row — sender is the human on the actor model
// `team-message-threads` ships (`from_kind: 'human'`, no sender session,
// origin = the team's main checkout root); this service adds no sender schema.
// Group targets ride the existing delivery rules untouched: one eligible
// member, worktree filtering, bounded spawning, transcript-confirmed receipts.
// Dispatch never changes task status (D9) and never creates a worktree.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type {
  AssignmentTarget,
  TaskDispatchPreview,
  TaskTargetOptions,
  TeamTask,
  TeamTaskAssignment,
} from '../../shared/teamTasks'
import type { TaskActor } from '../../shared/teamTasks'
import { loadGroupCatalog } from './groupCatalog'
import { resolveTeam, type TeamIdentity } from './teamIdentity'
import type { AssignmentStore } from './assignmentStore'
import { outstandingOf } from './assignmentStore'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'
import type { TaskCaller } from './TaskService'
import type { GroupDefinition } from './groupFile'
import type { TeamCaps } from './teamCaps'
import type { WorktreeStaffing } from './staffing'
import { worktreeRootOf, type TeamWorktrees } from './worktreeRoots'

/** How an outstanding assignment is handled by a reassignment (D7). */
export type ReassignHandling = 'notify' | 'stop'

export interface DispatchInput {
  taskId: string
  target: AssignmentTarget
  instruction: string
  /** The dispatch identity (D4): stable across retries of one user intent. */
  requestKey: string
  /** Required when the task has an outstanding assignment (D7). */
  handling?: ReassignHandling
}

export interface DispatchOutcome {
  /** True when the request key returned a prior, identical dispatch. */
  replay: boolean
  assignment: TeamTaskAssignment
  /** The instruction mail (the prior one on replay). */
  message: TeamMessage | null
}

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/
const nowIso = () => new Date().toISOString()

const targetLabel = (target: AssignmentTarget) => (target.kind === 'group' ? `group ${target.id}` : `session ${target.id}`)

const stateLabel = (assignment: TeamTaskAssignment) =>
  assignment.claimedBy ? `${assignment.state} (claimed by ${assignment.claimedBy})` : assignment.state

export class AssignmentService {
  constructor(private readonly db: Database, private readonly store: AssignmentStore, private readonly tasks: TaskStore,
    private readonly mail: MailboxStore, private readonly options: {
      getSession: (id: string) => ChatSessionRecord | null | undefined
      /** Every live chat session record (archived ones included; filtered here). */
      records: () => Iterable<ChatSessionRecord>
      /** A session's resolved team; undefined while resolving. */
      teamOf: (sessionId: string) => TeamIdentity | undefined
      staffing: WorktreeStaffing
      caps: TeamCaps
      worktrees: TeamWorktrees
      homeDir?: string
      /** Built-in cooldown end (ISO) of a profile, or null (preview skips cooling profiles). */
      cooldownUntil?: (profileId: string) => string | null
    }) {}

  /**
   * Dispatch an instruction under a request key (D3/D4/D7). Validation first,
   * then one transaction: reassignment writes (supersession, cancel-on-stop,
   * notify note), the assignment row, the instruction mail, and the journal
   * entry. A same-key replay of a completed dispatch — including a
   * reassignment — returns the prior outcome and writes nothing.
   */
  async dispatch(caller: TaskCaller, input: DispatchInput): Promise<DispatchOutcome> {
    const team = await this.teamOf(caller)
    const task = this.tasks.get(input.taskId)
    if (!task || task.teamId !== team.teamId) throw new Error(`Task not found in this team: ${input.taskId}`)
    const instruction = input.instruction.trim()
    if (!instruction) throw new Error('An assignment instruction is needed')
    const requestKey = input.requestKey.trim()
    if (!requestKey) throw new Error('A dispatch needs a request key')
    const group = input.target.kind === 'group' ? this.groupOf(team, input.target.id) : null
    const recipient = await this.sessionTarget(team, input.target)
    const role = input.target.kind === 'group' ? input.target.id : recipient?.groupId ?? null

    // The replay path resolves against committed rows before anything is
    // written: a reconnect resend, a double click, or a crash-then-retry can
    // never add a second instruction (D4).
    const existing = this.store.byKey(team.teamId, requestKey)
    if (existing) {
      const diff = this.payloadDiff(existing, { target: input.target, instruction })
      if (diff) throw new Error(`Request key already used with a different ${diff}`)
      return { replay: true, assignment: existing, message: existing.messageId ? this.mail.get(existing.messageId) : null }
    }

    const creator: TaskActor = { kind: 'human', sessionId: null }
    const message = this.db.transaction(() => {
      const outstanding = outstandingOf(this.store.listByTask(task.id))
      if (outstanding && !input.handling) {
        throw new Error(`Task already has an outstanding assignment: ${targetLabel({ kind: outstanding.targetKind, id: outstanding.targetId })}, ${stateLabel(outstanding)}. Choose notify or stop to reassign.`)
      }
      const inserted = this.store.insert({
        teamId: team.teamId, taskId: task.id, requestKey,
        targetKind: input.target.kind, targetId: input.target.id, role, instruction, creator,
      })
      const enqueued = this.mail.enqueue({
        teamId: team.teamId, toKind: input.target.kind, toId: input.target.id,
        fromKind: 'human', fromSession: null, fromGroup: null,
        originPath: team.groupsRoot, priority: 'normal', body: instruction,
        taskId: task.id, actor: 'human',
      })
      this.store.setMessage(inserted.assignment.id, enqueued.id)
      this.tasks.appendJournal(task.id, creator, `Assigned to ${targetLabel(input.target)} by human`)
      if (outstanding && input.handling) this.replace(outstanding, input.handling, task, input.target, team, inserted.assignment.id)
      return enqueued
    })()
    const assignment = this.store.byKey(team.teamId, requestKey)!
    return { replay: false, assignment, message: this.mail.get(message.id) }
  }

  /**
   * Reassignment writes (D7), inside the dispatch transaction: supersede the
   * old row, and per the human's choice either cancel the old instruction
   * (only while queued or waiting on a pending request — a `spawning`
   * reservation is left to staffing's lifecycle, claimed or delivered work is
   * never touched, nobody is killed or archived) or send the previous claimed
   * agent a fixed normal-priority direct note.
   */
  private replace(outstanding: TeamTaskAssignment, handling: ReassignHandling, task: TeamTask, target: AssignmentTarget, team: TeamIdentity, newId: string): void {
    const previous = { kind: outstanding.targetKind as 'group' | 'session', id: outstanding.targetId }
    if (handling === 'stop') {
      if (outstanding.messageId) this.mail.cancel(outstanding.messageId)
    } else if (outstanding.claimedBy && this.options.getSession(outstanding.claimedBy)) {
      this.mail.enqueue({
        teamId: task.teamId, toKind: 'session', toId: outstanding.claimedBy,
        fromKind: 'human', fromSession: null, fromGroup: null,
        originPath: team.groupsRoot,
        priority: 'normal', taskId: task.id, actor: 'human',
        body: `Task ${task.title} was reassigned to ${targetLabel(target)}; your work is not cancelled — report status with a journal note if still relevant.`,
      })
    }
    this.store.supersede(outstanding.id, newId, nowIso())
    this.tasks.appendJournal(task.id, { kind: 'human', sessionId: null },
      `Assignment to ${targetLabel(previous)} superseded by reassignment (${handling})`)
  }

  /**
   * Read-only dispatch preview (D6): the worktree the instruction would route
   * by, the role, the effective profile, the approval policy, and staffing
   * availability. Warns — never blocks — when a session target works outside
   * the task's worktree. Writes nothing and reserves nothing.
   */
  async preview(caller: TaskCaller, input: { taskId?: string; worktree?: string; target: AssignmentTarget }): Promise<TaskDispatchPreview> {
    const team = await this.teamOf(caller)
    let taskWorktree: string | null = null
    if (input.taskId) {
      const task = this.tasks.get(input.taskId)
      if (!task || task.teamId !== team.teamId) throw new Error(`Task not found in this team: ${input.taskId}`)
      taskWorktree = task.worktree
    } else if (input.worktree?.trim()) {
      const target = await this.options.worktrees.resolveTarget(team.teamId, input.worktree.trim())
      if (!target.ok) throw new Error(target.error)
      taskWorktree = target.root
    }
    if (input.target.kind === 'group') {
      const group = this.groupOf(team, input.target.id)
      return await this.previewGroup(team, taskWorktree, input.target, group)
    }
    const recipient = await this.sessionTarget(team, input.target)
    if (!recipient) throw new Error(`Unknown session: ${input.target.id}`)
    return this.previewSession(taskWorktree, input.target, recipient)
  }

  private async previewGroup(team: TeamIdentity, worktree: string | null, target: AssignmentTarget, group: GroupDefinition): Promise<TaskDispatchPreview> {
    const members = [...this.options.records()].filter(record =>
      record.archivedAt == null && record.groupId === target.id && this.options.teamOf(record.sessionId)?.teamId === team.teamId)
    const inWorktree = worktree === null ? members : members.filter(record => worktreeRootOf(record.projectPath) === worktree)
    const idleMembers = inWorktree.filter(record => record.status === 'waiting').map(record => record.sessionId)
    const spawnProfile = this.spawnProfile(group, team)
    let blockedBy: string | null = null
    if (worktree === null) blockedBy = 'the task has no target worktree'
    else {
      const counts = this.options.staffing.previewCounts(team.teamId, target.id, worktree)
      const teamCap = await this.options.caps.maxSpawnedSessions(team.teamId)
      if (counts.groupMembers >= group.max) blockedBy = `group ${target.id} is at its max of ${group.max} live members`
      else if (counts.teamSpawned >= teamCap) blockedBy = `the team is at its cap of ${teamCap} spawned sessions`
      else if (counts.worktreeWriters >= 1) blockedBy = `a spawned member already works in ${worktree}`
      else if (spawnProfile === null) blockedBy = 'every allowed profile is at its cap or cooling down'
    }
    return {
      worktree, target, role: group.label, profile: spawnProfile, approval: group.approval,
      sessionWorktree: null, idleMembers,
      spawn: { allowed: blockedBy === null, profile: spawnProfile, blockedBy },
      warning: null,
    }
  }

  private previewSession(worktree: string | null, target: AssignmentTarget, recipient: ChatSessionRecord): TaskDispatchPreview {
    const sessionWorktree = worktreeRootOf(recipient.projectPath)
    return {
      worktree, target, role: null,
      profile: recipient.claudeProfileId ?? 'default', approval: recipient.approvalPolicy ?? 'manual',
      sessionWorktree, idleMembers: [],
      spawn: { allowed: false, profile: null, blockedBy: 'the assignment names an existing session' },
      warning: worktree !== null && sessionWorktree !== worktree
        ? `Session works in ${sessionWorktree}; the task targets ${worktree}`
        : null,
    }
  }

  /** The first profile a spawn could use: group preference order, caps and cooldowns applied. */
  private spawnProfile(group: GroupDefinition, team: TeamIdentity): string | null {
    const allowed = group.profiles.length > 0 ? group.profiles : [{ profileId: 'default' }]
    const counts = this.options.staffing.previewCounts(team.teamId, group.id, '')
    const liveOn = new Map<string, number>()
    for (const member of counts.groupLive) {
      const profileId = member.claudeProfileId ?? 'default'
      liveOn.set(profileId, (liveOn.get(profileId) ?? 0) + 1)
    }
    for (const row of counts.pending) if (row.group_id === group.id) liveOn.set(row.profile_id, (liveOn.get(row.profile_id) ?? 0) + 1)
    const cooling = (profileId: string) => {
      const until = this.options.cooldownUntil?.(profileId) ?? null
      return until !== null && Date.parse(until) > Date.now()
    }
    for (const entry of allowed) {
      if (entry.cap !== undefined && (liveOn.get(entry.profileId) ?? 0) >= entry.cap) continue
      if (cooling(entry.profileId)) continue
      return entry.profileId
    }
    return null
  }

  /**
   * The pickers' data (D8): worktrees of the team's repository with their
   * branches, and the active OpenSpec changes found under the main checkout
   * root and each listed worktree — exactly the roots `validateChange`
   * accepts, so a listed choice always validates. `archive` is excluded.
   */
  async targets(caller: TaskCaller): Promise<TaskTargetOptions> {
    const team = await this.teamOf(caller)
    const worktrees = await this.options.worktrees.entries(team.teamId)
    // The main checkout is itself a listed worktree; read each root once.
    const roots = [...new Set([team.groupsRoot, ...worktrees.map(entry => entry.root)])]
    const changes = new Map<string, string[]>()
    for (const root of roots) {
      let names: string[]
      try {
        names = fs.readdirSync(path.join(root, 'openspec', 'changes'))
      } catch { continue }
      for (const name of names) {
        if (!CHANGE_NAME.test(name) || name === 'archive') continue
        try {
          if (!fs.statSync(path.join(root, 'openspec', 'changes', name)).isDirectory()) continue
        } catch { continue }
        changes.set(name, [...(changes.get(name) ?? []), root])
      }
    }
    return {
      worktrees,
      changes: [...changes.entries()].map(([name, locations]) => ({ name, locations })).sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  /** The caller's team: the human caller carries it; an agent resolves from its session. */
  private async teamOf(caller: TaskCaller): Promise<TeamIdentity> {
    if (caller.kind === 'human') return caller.team
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    return resolveTeam(session.projectPath)
  }

  private groupOf(team: TeamIdentity, id: string): GroupDefinition {
    const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}) })
    const group = catalog.groups.get(id)
    if (!group) throw new Error(`Unknown group: ${id}`)
    return group
  }

  /**
   * A live same-team session target, or null for group targets. Refuses an
   * unknown, archived, or other-team session before anything is written.
   */
  private async sessionTarget(team: TeamIdentity, target: AssignmentTarget): Promise<ChatSessionRecord | null> {
    if (target.kind !== 'session') return null
    const recipient = this.options.getSession(target.id)
    if (!recipient) throw new Error(`Unknown session: ${target.id}`)
    if (recipient.archivedAt != null) throw new Error(`Session ${target.id} is archived`)
    if ((await resolveTeam(recipient.projectPath)).teamId !== team.teamId) throw new Error(`Session ${target.id} belongs to another team`)
    return recipient
  }

  /** Which normalized request field differs between a stored dispatch and a replayed intent (D4). */
  private payloadDiff(existing: TeamTaskAssignment, input: { target: AssignmentTarget; instruction: string }): string | null {
    if (existing.targetKind !== input.target.kind || existing.targetId !== input.target.id) return 'target'
    if (existing.instruction !== input.instruction.trim()) return 'instruction'
    return null
  }
}
