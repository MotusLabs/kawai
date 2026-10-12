// Task tools on the per-session `kawai-team` MCP server (team-tasks design
// D2). Handlers bind the calling session id and strip unknown arguments, so
// a forged creator or team in the input is never seen by the service.
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'

export const TASK_TOOL_NAMES = ['task_create', 'task_get', 'task_note', 'task_update_status', 'task_amend', 'task_list'] as const

const status = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]])
const taskId = { task_id: z.string().min(1) }
export const taskSchemas = {
  task_create: z.object({
    title: z.string().min(1), direction: z.string().min(1), acceptance: z.string().optional(),
    parent_id: z.string().optional(), worktree: z.string().optional(), openspec_change: z.string().optional(),
  }),
  task_get: z.object(taskId),
  task_note: z.object({ ...taskId, text: z.string().min(1) }),
  task_update_status: z.object({ ...taskId, status, note: z.string().optional() }),
  task_amend: z.object({ ...taskId, direction: z.string().optional(), acceptance: z.string().optional() }),
  task_list: z.object({ status: status.optional() }),
}

export const taskDescriptions: Record<(typeof TASK_TOOL_NAMES)[number], string> = {
  task_create: 'Create a team task (only if your group may create tasks). Optional parent_id, worktree (a worktree root of this repository), and openspec_change. You become its creator.',
  task_get: 'Read a task in full: current direction and acceptance, every revision, the whole journal, subtasks, and its messages.',
  task_note: "Append a note to a task's journal (decisions, findings, progress). Notes are permanent.",
  task_update_status: 'Set a task to active or blocked (any member); done or cancelled (its creator only). Optional note is journaled.',
  task_amend: "Change a task's direction or acceptance criteria (its creator only); creates a new revision.",
  task_list: "List this team's tasks, optionally by status.",
}

export function taskHandlers(tasks: TaskService, sessionId: string) {
  const caller = { kind: 'agent' as const, sessionId }
  return {
    task_create: async (input: unknown) => tasks.create(caller, taskSchemas.task_create.parse(input)),
    task_get: async (input: unknown) => tasks.get(caller, taskSchemas.task_get.parse(input).task_id),
    task_note: async (input: unknown) => {
      const { task_id, text } = taskSchemas.task_note.parse(input)
      return tasks.note(caller, task_id, text)
    },
    task_update_status: async (input: unknown) => {
      const { task_id, status: next, note } = taskSchemas.task_update_status.parse(input)
      return tasks.setStatus(caller, task_id, next, note)
    },
    task_amend: async (input: unknown) => {
      const { task_id, direction, acceptance } = taskSchemas.task_amend.parse(input)
      return tasks.amend(caller, task_id, { direction, acceptance })
    },
    task_list: async (input: unknown) => tasks.list(caller, taskSchemas.task_list.parse(input).status),
  }
}
