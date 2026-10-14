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
import type { TaskActor, TaskStatus, TeamTask, TeamTaskDetail, TeamTaskSummary } from '../../shared/teamTasks'
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

/** Who is calling: an agent session (identity bound) or the human for a team. */
export type TaskCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

export class TaskService {
  readonly worktrees: TeamWorktrees

  constructor(readonly store: TaskStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
    worktrees?: TeamWorktrees
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
    if (note?.trim()) this.store.appendJournal(taskId, actor, note.trim())
    return this.store.setStatus(taskId, status)!
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
