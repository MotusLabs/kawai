// Task operations with identity and permissions (team-tasks design D2).
// Agent calls are bound to the calling session — its team, group, and
// creator identity come from the session record and the group files as they
// are now, never from tool arguments. Human calls arrive through the
// authenticated UI connection with a team already resolved. Rules:
// - create: the human, or an agent whose current group sets canCreateTasks;
// - amend direction/acceptance: the task's creator or the human;
// - journal notes and active/blocked: any member of the team, and the human;
// - done/cancelled: the creator; every status (including reopening): the human.
// References are validated before anything is written: parent tasks of the
// same team, worktrees listed for the team's repository (stored as their
// root), and OpenSpec changes that exist.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import type { TaskActor, TaskDraft, TaskStatus, TeamTask, TeamTaskDetail, TeamTaskSummary } from '../../shared/teamTasks'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { loadTeamGroups } from './teamGroups'
import type { TeamIdentity } from './teamIdentity'
import type { TaskStore } from './taskStore'
import { TeamWorktrees } from './worktreeRoots'

export interface TaskCreateInput {
  title: string
  direction: string
  acceptance?: string | null
  parent_id?: string | null
  worktree?: string | null
  openspec_change?: string | null
  /** Stable client request key (task-assignment D4): replays deduplicate. */
  requestKey?: string | null
}

export interface TaskAmendInput {
  direction?: string
  acceptance?: string | null
}

/** The human's draft of a new direction (task-revision-publication D1). */
export interface TaskDraftInput {
  /** The published revision it edits; the current one when omitted. */
  baseRevision?: number
  direction: string
  acceptance?: string | null
  rationale?: string | null
}

/** Who is calling: an agent session (identity bound) or the human for a team. */
export type TaskCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** How often setStatus re-prepares when the status moves during its hook's await. */
const STATUS_ATTEMPTS = 3

export class TaskService {
  readonly worktrees: TeamWorktrees

  constructor(readonly store: TaskStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
    worktrees?: TeamWorktrees
    /**
     * A status transition into or out of `done`/`cancelled` (member-release
     * D1/D8): resolved first, then run inside the status transaction.
     */
    onStatusTransition?: (task: TeamTask, status: TaskStatus, actor: TaskActor) => Promise<() => void>
  }) {
    this.worktrees = options.worktrees ?? new TeamWorktrees()
  }

  async create(caller: TaskCaller, input: TaskCreateInput): Promise<TeamTask> {
    const { team, actor, canCreate } = await this.context(caller)
    if (!canCreate) {
      throw new Error("Your group cannot create tasks (its group file does not set canCreateTasks: true). Ask a team lead or the human to create one.")
    }
    const title = input.title.trim()
    const direction = input.direction.trim()
    if (!title) throw new Error('A task needs a title')
    if (!direction) throw new Error('A task needs a direction')
    if (input.parent_id) this.sameTeamTask(team, input.parent_id, 'Parent task')
    let worktree: string | null = null
    if (input.worktree) {
      const target = await this.worktrees.resolveTarget(team.teamId, input.worktree)
      if (!target.ok) throw new Error(target.error)
      worktree = target.root
    }
    const openspecChange = input.openspec_change ? this.validateChange(team, input.openspec_change, worktree) : null
    return this.store.create({
      teamId: team.teamId, title, direction, acceptance: emptyToNull(input.acceptance), creator: actor,
      parentId: input.parent_id || null, worktree, openspecChange,
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    })
  }

  async get(caller: TaskCaller, taskId: string): Promise<TeamTaskDetail> {
    const { team } = await this.context(caller)
    this.sameTeamTask(team, taskId)
    return this.store.detail(taskId)!
  }

  async list(caller: TaskCaller, status?: TaskStatus): Promise<TeamTaskSummary[]> {
    const { team } = await this.context(caller)
    return this.store.list(team.teamId).filter(task => !status || task.status === status)
  }

  async amend(caller: TaskCaller, taskId: string, change: TaskAmendInput): Promise<TeamTask> {
    const { team, actor } = await this.context(caller)
    const task = this.sameTeamTask(team, taskId)
    if (actor.kind === 'agent' && task.creator.sessionId !== actor.sessionId) {
      throw new Error(`Only the task's creator or the human can amend its direction. Add a journal note with task_note, or message the creator${task.creator.sessionId ? ` (${task.creator.sessionId})` : ' (the human)'} instead.`)
    }
    if (change.direction === undefined && change.acceptance === undefined) throw new Error('Nothing to amend: give a direction or acceptance criteria')
    if (change.direction !== undefined && !change.direction.trim()) throw new Error('A task needs a direction')
    return this.store.amend(taskId, {
      ...(change.direction !== undefined ? { direction: change.direction.trim() } : {}),
      ...(change.acceptance !== undefined ? { acceptance: emptyToNull(change.acceptance) } : {}),
    }, actor)!
  }

  /**
   * Save the human's draft (D1). Agents have none — their working context is
   * already a draft, so they publish with task_amend. Nothing is published,
   * mailed, or announced as a task change; only the human's view refreshes.
   */
  async saveDraft(caller: TaskCaller, taskId: string, input: TaskDraftInput): Promise<TaskDraft> {
    const task = await this.humanTask(caller, taskId)
    const direction = input.direction.trim()
    if (!direction) throw new Error('A draft needs a direction')
    const baseRevision = input.baseRevision ?? task.revision
    if (!Number.isInteger(baseRevision) || baseRevision < 1 || baseRevision > task.revision) {
      throw new Error(`A draft must be based on a published revision (1–${task.revision})`)
    }
    return this.store.drafts.save(taskId, {
      baseRevision, direction, acceptance: emptyToNull(input.acceptance), rationale: emptyToNull(input.rationale),
    })
  }

  /** Move the draft onto the current revision, keeping its text (D1). */
  async rebaseDraft(caller: TaskCaller, taskId: string): Promise<TaskDraft> {
    const task = await this.humanTask(caller, taskId)
    const draft = this.store.drafts.rebase(taskId, task.revision)
    if (!draft) throw new Error('This task has no draft to rebase')
    return draft
  }

  async discardDraft(caller: TaskCaller, taskId: string): Promise<void> {
    await this.humanTask(caller, taskId)
    this.store.drafts.discard(taskId)
  }

  async note(caller: TaskCaller, taskId: string, text: string) {
    const { team, actor } = await this.context(caller)
    this.sameTeamTask(team, taskId)
    if (!text.trim()) throw new Error('A journal note needs text')
    return this.store.appendJournal(taskId, actor, text.trim())!
  }

  async setStatus(caller: TaskCaller, taskId: string, status: TaskStatus, note?: string): Promise<TeamTask> {
    const { team, actor } = await this.context(caller)
    const task = this.sameTeamTask(team, taskId)
    if (!TASK_STATUSES.includes(status)) throw new Error(`Unknown task status: ${String(status)}`)
    if (actor.kind === 'agent') {
      const isCreator = task.creator.sessionId === actor.sessionId
      if (status === 'open') throw new Error('Only the human can reopen a task')
      if ((status === 'done' || status === 'cancelled') && !isCreator) {
        throw new Error(`Only the task's creator can set it to ${status}. Report your result in a journal note or a message to the creator instead.`)
      }
    }
    // The closed/open boundary is decided on a snapshot; preparing its hook
    // awaits group definitions, so the status may move meanwhile. Re-read
    // after the await and commit in the same tick only if it held; else
    // prepare again on the fresh status, and refuse as stale after a few.
    let current = task
    for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
      const within = this.crossesBoundary(current.status, status)
        ? await this.options.onStatusTransition!(current, status, actor)
        : undefined
      const fresh = this.store.get(taskId)
      if (!fresh) throw new Error(`Unknown task: ${taskId}`)
      if (fresh.status === current.status) {
        if (note?.trim()) this.store.appendJournal(taskId, actor, note.trim())
        return this.store.setStatus(taskId, status, within)!
      }
      current = fresh
    }
    throw new Error(`Task ${taskId} kept changing status while this update was prepared (now ${current.status}); nothing changed. Try again.`)
  }

  /** Whether moving from `from` to `to` crosses the closed/open boundary the transition hook handles. */
  private crossesBoundary(from: TaskStatus, to: TaskStatus): boolean {
    if (!this.options.onStatusTransition || from === to) return false
    return (from === 'done' || from === 'cancelled') !== (to === 'done' || to === 'cancelled')
  }

  /** The caller's team, actor identity, and current creation right. */
  private async context(caller: TaskCaller) {
    if (caller.kind === 'human') {
      return { team: caller.team, actor: { kind: 'human', sessionId: null } as TaskActor, canCreate: true }
    }
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    // Read at call time: an edited group file applies to the next call.
    const { team, catalog } = await loadTeamGroups(session.projectPath, this.options.homeDir)
    const group = session.groupId ? catalog.groups.get(session.groupId) : undefined
    return {
      team,
      actor: { kind: 'agent', sessionId: session.sessionId } as TaskActor,
      canCreate: group?.canCreateTasks === true,
    }
  }

  /** A task of the human caller's team; agents are refused (drafts are the human's, D1/D7). */
  private async humanTask(caller: TaskCaller, taskId: string): Promise<TeamTask> {
    if (caller.kind !== 'human') throw new Error("Drafts are the human's; agents publish directly with task_amend")
    const { team } = await this.context(caller)
    return this.sameTeamTask(team, taskId)
  }

  /** The task, if it belongs to the team; otherwise an error that leaks nothing. */
  private sameTeamTask(team: TeamIdentity, taskId: string, label = 'Task'): TeamTask {
    const task = this.store.get(taskId)
    if (!task || task.teamId !== team.teamId) throw new Error(`${label} not found in this team: ${taskId}`)
    return task
  }

  /** An active change in the main checkout or in the task's worktree. */
  private validateChange(team: TeamIdentity, name: string, worktree: string | null): string {
    const change = name.trim()
    const roots = [team.groupsRoot, ...(worktree ? [worktree] : [])]
    const isChange = (root: string) => {
      try { return fs.statSync(path.join(root, 'openspec', 'changes', change)).isDirectory() } catch { return false }
    }
    if (CHANGE_NAME.test(change) && change !== 'archive' && roots.some(isChange)) {
      return change
    }
    throw new Error(`OpenSpec change not found: ${name} (looked in ${roots.map(root => path.join(root, 'openspec', 'changes')).join(' and ')})`)
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null
}
