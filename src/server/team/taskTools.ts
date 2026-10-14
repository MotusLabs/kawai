// Task tools on the per-session `kawai-team` MCP server (team-tasks design
// D2). Handlers bind the calling session id and strip unknown arguments, so
// a forged creator or team in the input is never seen by the service.
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'
import type { TaskResultService } from './TaskResultService'

export const TASK_TOOL_NAMES = ['task_create', 'task_get', 'task_note', 'task_update_status', 'task_amend', 'task_list', 'task_acknowledge',
  'task_submit_result'] as const

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
  task_amend: z.object({
    ...taskId, direction: z.string().optional(), acceptance: z.string().optional(),
    rationale: z.string().optional(), notify: z.boolean().optional(),
  }),
  task_list: z.object({ status: status.optional() }),
  task_acknowledge: z.object({ ...taskId, revision: z.number().int().min(1) }),
  task_submit_result: z.object({
    ...taskId, summary: z.string().min(1), commit: z.string().optional(), diff: z.string().optional(),
    tests: z.array(z.object({ description: z.string().min(1), outcome: z.string().min(1) })).optional(),
    limitations: z.string().optional(),
  }),
}

export const taskDescriptions: Record<(typeof TASK_TOOL_NAMES)[number], string> = {
  task_create: 'Create a team task (only if your group may create tasks). Optional parent_id, worktree (a worktree root of this repository), and openspec_change. You become its creator.',
  task_get: 'Read a task in full: current direction and acceptance, every revision, the whole journal, subtasks, and its messages.',
  task_note: "Append a note to a task's journal (decisions, findings, progress). Notes are permanent.",
  task_update_status: 'Set a task to active or blocked (any member); done or cancelled (its creator only). Optional note is journaled.',
  task_amend: "Publish a new revision of a task's direction or acceptance criteria (its creator only). Optional rationale says why; notify: true also sends the assignment's claimed agent a revision notice.",
  task_list: "List this team's tasks, optionally by status.",
  task_acknowledge: 'State the published task revision you are now working from (the revision in the task header). Call it when you start or take over work on a task, and after a revision notice.',
  task_submit_result: 'Submit a result for a task: a summary, a commit and/or diff reference (at least one), the tests you ran with their outcomes, and known limitations. Your test outcomes are shown as claimed, not verified. Supersedes the task\'s previous result; does not close the task.',
}

export function taskHandlers(tasks: TaskService, sessionId: string, results?: TaskResultService) {
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
      const { task_id, direction, acceptance, rationale, notify } = taskSchemas.task_amend.parse(input)
      return tasks.amend(caller, task_id, { direction, acceptance, rationale, notify })
    },
    task_acknowledge: async (input: unknown) => {
      const { task_id, revision } = taskSchemas.task_acknowledge.parse(input)
      return tasks.acknowledge(caller, task_id, revision)
    },
    // Results (task-results-handoffs): registered only where the server has a result service.
    ...(results ? {
      task_submit_result: async (input: unknown) => {
        const { task_id, ...submission } = taskSchemas.task_submit_result.parse(input)
        return results.submit(caller, task_id, submission)
      },
    } : {}),
    task_list: async (input: unknown) => tasks.list(caller, taskSchemas.task_list.parse(input).status),
  }
}
