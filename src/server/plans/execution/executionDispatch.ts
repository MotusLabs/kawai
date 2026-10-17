// Kawai's task creation and the implement dispatch (plan-execution D7/D8,
// §11.4). The system TaskCaller is minted HERE and nowhere else (D2): the
// constructor below is module-private, so no tool handler or WebSocket
// connection path can build one. The whole step is idempotent the way its
// pieces are: the task exists or is created, the attempt row exists or is
// inserted, and the dispatch replays by its request key
// `exec:<execution>:<change>:attempt:<n>:<generation>` — a restart between
// the pieces resumes without a second instruction.
import { createHash } from 'node:crypto'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskCaller, TaskService } from '../../team/TaskService'
import type { AssignmentService } from '../../team/AssignmentService'
import { runGitAsync } from '../../git/gitCommand'
import { manifestHashInput, type AttemptManifest } from '../../../shared/planExecution'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { implementInstruction } from './instructions'

/** The system caller (D2): minted only inside this module. */
function kawaiCaller(team: TeamIdentity, executionId: string): TaskCaller {
  return { kind: 'system', team, executionId }
}

export interface DispatchDeps {
  team: TeamIdentity
  executions: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  assignments: AssignmentService
}

/** sha256 of `git show <startCommit>:<path>` for each validated file (D8's digest). */
async function artifactsAt(cwd: string, startCommit: string, files: string[]): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {}
  for (const file of files) {
    const blob = await runGitAsync(['show', `${startCommit}:${file}`], { cwd })
    if (blob.ok) artifacts[file] = createHash('sha256').update(blob.stdout).digest('hex')
  }
  return artifacts
}

/**
 * Create Kawai's task for the change and dispatch the implement attempt
 * (D7, D8). Idempotent per piece: an existing task or attempt row is kept,
 * and the dispatch replays under its request key.
 */
export async function dispatchImplementAttempt(deps: DispatchDeps, input: { executionId: string; change: string; group: string }): Promise<void> {
  const execution = deps.executions.execution(input.executionId)
  if (execution === null) return
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null || changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  if (revision === null) return
  const entry = revision.content.changes.find(candidate => candidate.change === input.change)
  if (!entry) return
  const roleProfiles = revision.content.roles.find(role => role.group === input.group)?.profiles ?? []

  // The task (D7): title, direction, acceptance, worktree, openspec link, plan link.
  let taskId = changeRow.taskId
  if (taskId === null) {
    const task = await deps.tasks.create(kawaiCaller(deps.team, input.executionId), {
      title: `${input.change} — ${deps.plans.get(execution.planId)?.title ?? execution.planId}`,
      direction: `The OpenSpec change "${input.change}" is the authoritative direction for this task; its proposal, design, and tasks under openspec/changes/${input.change}/ govern the work.\n\n${entry.guidance}`.trim(),
      acceptance: [...entry.acceptance, ...revision.content.acceptanceRules].join('\n') || null,
      worktree: changeRow.worktree,
      openspec_change: input.change,
      plan_id: execution.planId,
      plan_change: input.change,
    })
    taskId = task.id
    deps.executions.transition(input.executionId, input.change, { state: changeRow.state, generation: changeRow.generation }, { taskId })
  }

  // The attempt and its immutable manifest (D8), then the keyed dispatch.
  const existing = deps.executions.attempts(input.executionId, input.change)
  let number = existing.length
  let manifestHash = existing.at(-1)?.manifestHash
  if (existing.length === 0) {
    const head = await runGitAsync(['rev-parse', 'HEAD'], { cwd: changeRow.worktree })
    const startCommit = head.ok ? head.stdout.trim() : changeRow.baselineCommit
    const files = await runGitAsync(['ls-tree', '-r', '--name-only', startCommit], { cwd: changeRow.worktree })
    const artifacts = await artifactsAt(changeRow.worktree, startCommit, files.ok ? files.stdout.trim().split('\n').filter(Boolean) : [])
    const manifest: AttemptManifest = {
      version: 1,
      plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
      execution: input.executionId,
      task: { id: taskId, revision: deps.tasks.store.get(taskId)?.revision ?? 1 },
      validation: { reportId: execution.reportId, inputHash: execution.inputHash },
      baseline: changeRow.baselineCommit,
      startCommit,
      artifacts,
      roleProfiles,
    }
    manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
    const attempt = deps.executions.insertAttempt({
      executionId: input.executionId, change: input.change, kind: 'implement', assignmentId: null,
      manifest, manifestHash,
    })
    number = attempt.number
  }

  const change = deps.executions.change(input.executionId, input.change)!
  const requestKey = `exec:${input.executionId}:${input.change}:attempt:${number}:${change.generation}`
  await deps.assignments.dispatch(kawaiCaller(deps.team, input.executionId), {
    taskId,
    target: { kind: 'group', id: input.group },
    instruction: implementInstruction({
      planTitle: deps.plans.get(execution.planId)?.title ?? execution.planId,
      revision: execution.revision,
      change: input.change,
      worktree: changeRow.worktree!,
      branch: changeRow.branch!,
      baseline: changeRow.baselineCommit!,
      head: existing.length === 0 ? (await runGitAsync(['rev-parse', 'HEAD'], { cwd: changeRow.worktree })).stdout.trim() : changeRow.baselineCommit!,
      acceptance: [...entry.acceptance, ...revision.content.acceptanceRules],
      extraChecks: entry.extraChecks.map(check => check.name),
      guidance: entry.guidance,
      taskId,
      manifestHash: manifestHash!,
    }),
    requestKey,
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
  })
}
