// Task tools on the per-session `kawai-team` MCP server (team-tasks design
// D2). Handlers bind the calling session id and strip unknown arguments, so
// a forged creator or team in the input is never seen by the service.
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'
import type { TaskResultService } from './TaskResultService'

export const TASK_TOOL_NAMES = ['task_create', 'task_get', 'task_note', 'task_update_status', 'task_amend', 'task_list', 'task_acknowledge',
  'task_submit_result', 'task_submit_findings', 'task_handoff', 'task_check_result'] as const

const status = z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]])
const taskId = { task_id: z.string().min(1) }
export const taskSchemas = {
  task_create: z.object({
    title: z.string().min(1), direction: z.string().min(1), acceptance: z.string().optional(),
    parent_id: z.string().optional(), worktree: z.string().optional(), openspec_change: z.string().optional(),
    plan_id: z.string().optional(), plan_change: z.string().optional(),
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
    // The coverage map's shape is D5's, checked by validateCoverageMap at the
    // service boundary — a clause-indexed refusal the zod layer cannot name.
    coverage: z.unknown().optional(),
  }),
  task_submit_findings: z.object({
    ...taskId, result_id: z.string().min(1), kind: z.enum(['review', 'qa']), verdict: z.enum(['pass', 'fail']), findings: z.string().min(1),
  }),
  task_handoff: z.object({
    ...taskId, kind: z.enum(['review', 'qa', 'fix']), result_id: z.string().min(1), target: z.string().min(1),
    // Explicit recipient kind (session-targeted-task-handoffs D1): omitted
    // means group, even when the id resembles a session id — never inferred.
    target_kind: z.enum(['group', 'session']).optional(),
    instructions: z.string().min(1), expected_response: z.string().optional(),
    // The worker choice (dispatch-worker-choice D7): group targets only.
    worker: z.string().min(1).optional(),
  }),
  task_check_result: z.object({ ...taskId, result_id: z.string().min(1) }),
}

export const taskDescriptions: Record<(typeof TASK_TOOL_NAMES)[number], string> = {
  task_create: 'Create a team task (only if your group may create tasks). Optional parent_id, worktree (a worktree root of this repository), and openspec_change; plan_id with plan_change links the task to a change of an open plan\'s approved revision (both or neither; fixed afterwards). You become its creator.',
  task_get: 'Read a task in full: current direction and acceptance, every revision, the whole journal, subtasks, and its messages.',
  task_note: "Append a note to a task's journal (decisions, findings, progress). Notes are permanent.",
  task_update_status: 'Set a task to active or blocked (any member); done or cancelled (its creator only). Optional note is journaled.',
  task_amend: "Publish a new revision of a task's direction or acceptance criteria (its creator only). Optional rationale says why; notify: true also sends the assignment's claimed agent a revision notice.",
  task_list: "List this team's tasks, optionally by status.",
  task_acknowledge: 'State the published task revision you are now working from (the revision in the task header). Call it when you start or take over work on a task, and after a revision notice.',
  task_submit_result: 'Submit a result for a task: a summary, a commit and/or diff reference (at least one), the tests you ran with their outcomes, and known limitations. Your test outcomes are shown as claimed, not verified. Supersedes the task\'s previous result; does not close the task.',
  task_submit_findings: 'Report review or QA findings on one exact result (result_id from task_get): kind review|qa, verdict pass|fail, and the findings. They stay bound to that result — a newer result inherits nothing.',
  task_handoff: 'Hand a result off (kind review, qa, or fix — return for fixes; the result_id, instructions, and an optional expected_response) to a recipient: target_kind "group" (the default when omitted, even for a session-shaped id) with target: <group id>, or target_kind "session" with target: <session id> to dispatch ordinary direct task mail to that exact session — no other member is chosen. While an equivalent handoff (same task, result, kind) is outstanding, this returns it instead of dispatching again; if the standing handoff names another recipient, the notice says so and nothing is reassigned. Optional worker (group targets only) limits who may take it to one provider (e.g. claude) or one model (provider/model, or a bare model key) of the group\'s workers, as on send_message; a handoff naming another worker is another handoff.',
  task_check_result: 'Ask Kawai to check a result again (result_id from task_get): the commit, its worktree state, the recorded full-check pass, and merges against the base and other open tasks\' branches. The check never gates anything; it runs in the background and the newest check rides task_get. A request while a check is pending returns that pending check.',
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
      task_submit_findings: async (input: unknown) => {
        const { task_id, result_id, kind, verdict, findings } = taskSchemas.task_submit_findings.parse(input)
        return results.submitFindings(caller, task_id, { resultId: result_id, kind, verdict, findings })
      },
      task_handoff: async (input: unknown) => {
        const { task_id, kind, result_id, target_kind, target, instructions, expected_response, worker } = taskSchemas.task_handoff.parse(input)
        const id = target.trim()
        if (!id) throw new Error('A handoff target needs an identifier')
        return results.handoff(caller, task_id, {
          kind, resultId: result_id, target: { kind: target_kind ?? 'group', id }, instructions, expectedResponse: expected_response ?? null,
          ...(worker !== undefined ? { worker } : {}),
        })
      },
      task_check_result: async (input: unknown) => {
        const { task_id, result_id } = taskSchemas.task_check_result.parse(input)
        return results.recheck(caller, task_id, result_id)
      },
    } : {}),
    task_list: async (input: unknown) => tasks.list(caller, taskSchemas.task_list.parse(input).status),
  }
}
