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
import type { TaskResultService } from '../../team/TaskResultService'
import { runGitAsync } from '../../git/gitCommand'
import { manifestHashInput, type AttemptManifest } from '../../../shared/planExecution'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { fixInstruction, implementInstruction } from './instructions'
import { refusable } from './stepRefusal'
import { effectiveExtraChecks } from '../../../shared/planExecutionGates'

/** The system caller (D2): minted only inside this module. */
function kawaiCaller(team: TeamIdentity, executionId: string): TaskCaller {
  return { kind: 'system', team, origin: { kind: 'execution', executionId } }
}

export interface DispatchDeps {
  team: TeamIdentity
  executions: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  assignments: AssignmentService
  /** Fix and review stages dispatch as handoffs, superseding the prior stage (D7). */
  results: TaskResultService
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
    const task = await refusable('implement', () => deps.tasks.create(kawaiCaller(deps.team, input.executionId), {
      title: `${input.change} — ${deps.plans.get(execution.planId)?.title ?? execution.planId}`,
      direction: `The OpenSpec change "${input.change}" is the authoritative direction for this task; its proposal, design, and tasks under openspec/changes/${input.change}/ govern the work.\n\n${entry.guidance}`.trim(),
      acceptance: [...entry.acceptance, ...revision.content.acceptanceRules].join('\n') || null,
      worktree: changeRow.worktree,
      openspec_change: input.change,
      plan_id: execution.planId,
      plan_change: input.change,
    }))
    taskId = task.id
    deps.executions.transition(input.executionId, input.change, { state: changeRow.state, generation: changeRow.generation }, { taskId })
  }

  // The attempt and its immutable manifest (D8), then the keyed dispatch.
  const existing = deps.executions.attempts(input.executionId, input.change)
  let number = existing.length
  let manifestHash = existing.at(-1)?.manifestHash
  let attemptId = existing.at(-1)?.id
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
    attemptId = attempt.id
  }

  const change = deps.executions.change(input.executionId, input.change)!
  const requestKey = `exec:${input.executionId}:${input.change}:attempt:${number}:${change.generation}`
  const head = existing.length === 0
    ? (await runGitAsync(['rev-parse', 'HEAD'], { cwd: changeRow.worktree! })).stdout.trim()
    : changeRow.baselineCommit!
  const outcome = await refusable('implement', () => deps.assignments.dispatch(kawaiCaller(deps.team, input.executionId), {
    taskId: taskId!,
    target: { kind: 'group', id: input.group },
    instruction: implementInstruction({
      planTitle: deps.plans.get(execution.planId)?.title ?? execution.planId,
      revision: execution.revision,
      change: input.change,
      worktree: changeRow.worktree!,
      branch: changeRow.branch!,
      baseline: changeRow.baselineCommit!,
      head,
      acceptance: [...entry.acceptance, ...revision.content.acceptanceRules],
      extraChecks: effectiveExtraChecks(revision.content, entry).map(check => check.name),
      guidance: entry.guidance,
      taskId: taskId!,
      manifestHash: manifestHash!,
      integrationBranch: integrationBranchOf(execution),
    }),
    requestKey,
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
  }))
  deps.executions.setAttemptAssignment(attemptId!, outcome.assignment.id)
}

/** What a fix attempt names: the failed round's checks and findings, and where to continue. */
export interface FixAttemptInput {
  executionId: string
  change: string
  group: string
  failingChecks: Array<{ name: string; conclusion: string; link: string | null }>
  findingsIds: string[]
  findingsTexts: string[]
  continueFrom: string
  fixRounds: number
}

/**
 * The fix attempt row (D12), created or reused; null when the change cannot
 * take one. Split from the dispatch so a hold can create the attempt — the
 * owed dispatch's marker (revision-control 3.2) — without sending the
 * handoff.
 */
export async function ensureFixAttempt(deps: DispatchDeps, input: FixAttemptInput): Promise<{ id: string; number: number; manifestHash: string } | null> {
  const execution = deps.executions.execution(input.executionId)
  if (execution === null) return null
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null || changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null || changeRow.taskId === null) return null
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === input.change)
  if (revision === null || entry === undefined) return null
  const roleProfiles = revision.content.roles.find(role => role.group === input.group)?.profiles ?? []
  const round = deps.executions.rounds(input.executionId, input.change).at(-1) ?? null
  const taskId = changeRow.taskId

  const existing = deps.executions.attempts(input.executionId, input.change)
  // An attempt answers one round — its manifest's answers.roundId. The
  // newest fix attempt is reused only while it answers the round the change
  // now stands on (the failed round, or the round a newer task revision
  // superseded): a later round owes its own attempt, so the owed dispatch's
  // marker — the outstanding assignment's request key — can never settle a
  // later round's debt with an earlier round's key (revision-control 3.2,
  // review B1). The same-round reuse stays: a revision stage re-planned for
  // a newer task revision must not mint an attempt per tick.
  const newest = existing.at(-1)
  if (newest !== undefined && newest.kind === 'fix' && newest.manifest.answers !== undefined
    && newest.manifest.answers.roundId === round?.id) {
    return { id: newest.id, number: newest.number, manifestHash: newest.manifestHash }
  }
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
    answers: {
      resultId: round?.resultId ?? '',
      roundId: round?.id ?? '',
      failingChecks: input.failingChecks.map(check => ({
        name: check.name, source: 'actions' as const, conclusion: check.conclusion, link: check.link,
        startedAt: null, completedAt: null,
        ...(check.link?.match(/\/runs\/(\d+)/) ? { runId: Number(check.link.match(/\/runs\/(\d+)/)![1]) } : {}),
      })),
      findingsIds: input.findingsIds,
    },
  }
  const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
  const attempt = deps.executions.insertAttempt({
    executionId: input.executionId, change: input.change, kind: 'fix', assignmentId: null,
    manifest, manifestHash,
  })
  return { id: attempt.id, number: attempt.number, manifestHash }
}

/**
 * The fix attempt after a failed round (D12): one more attempt of the change
 * with `answers` naming what it fixes — the failing checks, the findings,
 * the count, and the commit to continue from. The key is
 * `exec:<execution>:<change>:attempt:<n>:<generation>`; a retry replays it.
 */
export async function dispatchFixAttempt(deps: DispatchDeps, input: FixAttemptInput): Promise<void> {
  const attempt = await ensureFixAttempt(deps, input)
  if (attempt === null) return
  await dispatchFix(deps, input, attempt)
}

/** The keyed handoff of an existing fix attempt (D12): the instruction names what it fixes. Exported for the gated fix step and the owed dispatch (revision-control 3.2). */
export async function dispatchFix(deps: DispatchDeps, input: FixAttemptInput, attempt: { id: string; number: number; manifestHash: string }): Promise<void> {
  const execution = deps.executions.execution(input.executionId)
  if (execution === null) return
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null || changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null || changeRow.taskId === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === input.change)
  if (revision === null || entry === undefined) return
  const roleProfiles = revision.content.roles.find(role => role.group === input.group)?.profiles ?? []
  const round = deps.executions.rounds(input.executionId, input.change).at(-1) ?? null
  const taskId = changeRow.taskId

  const requestKey = `exec:${input.executionId}:${input.change}:attempt:${attempt.number}:${changeRow.generation}`
  const instruction = fixInstruction({
    planTitle: deps.plans.get(execution.planId)?.title ?? execution.planId,
    revision: execution.revision,
    change: input.change,
    worktree: changeRow.worktree,
    branch: changeRow.branch,
    baseline: changeRow.baselineCommit,
    head: input.continueFrom,
    acceptance: [...entry.acceptance, ...revision.content.acceptanceRules],
    extraChecks: effectiveExtraChecks(revision.content, entry).map(check => check.name),
    guidance: entry.guidance,
    taskId,
    manifestHash: attempt.manifestHash,
    integrationBranch: integrationBranchOf(execution),
    failingChecks: input.failingChecks,
    findings: input.findingsTexts,
    fixRounds: input.fixRounds,
    continueFrom: input.continueFrom,
  })
  // A fix is a handoff (D7): it supersedes the outstanding review through
  // the stop branch, so a delivered review never holds the change.
  const outcome = await refusable('fix', () => deps.results.handoff(kawaiCaller(deps.team, input.executionId), taskId, {
    kind: 'fix', resultId: round?.resultId ?? '', target: { kind: 'group', id: input.group },
    instructions: instruction, requestKey,
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
  }))
  deps.executions.setAttemptAssignment(attempt.id, outcome.assignment.id)
}

/**
 * The owed fix dispatch of a released hold (revision-control 3.2): the fix
 * attempt row exists — the hold's marker — but its handoff never sent. The
 * attempt is reused, the instruction's texts are rebuilt from the round it
 * answers (a superseded round names the republished direction, a failed
 * round its failing checks and the verdict's findings), and the handoff
 * dispatches once under the attempt's own request key: a re-run replays it,
 * and once sent the assignment carries the key, so nothing is owed again.
 */
export async function dispatchOwedFixAttempt(deps: DispatchDeps, input: { executionId: string; change: string; group: string }): Promise<void> {
  const newest = deps.executions.attempts(input.executionId, input.change).at(-1)
  if (newest === undefined || newest.kind !== 'fix') return
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null) return
  const round = newest.manifest.answers !== undefined
    ? deps.executions.round(newest.manifest.answers.roundId) ?? null
    : null
  let failingChecks: FixAttemptInput['failingChecks'] = []
  let findingsIds: string[] = []
  let findingsTexts: string[] = []
  // The texts are rebuilt at send time from the round the attempt answers —
  // the manifest keeps only ids. A superseded round's owed fix names the
  // task's CURRENT revision (a second republish after the attempt was minted
  // is still the round's answer), a failed round its failing checks and the
  // verdict's findings.
  if (round?.outcome === 'superseded') {
    const task = changeRow.taskId === null ? null : deps.tasks.store.get(changeRow.taskId)
    const rationale = task === null || task === undefined ? null : deps.tasks.store.revisions(task.id).at(-1)?.rationale ?? null
    findingsTexts = [`The task's direction was republished as revision ${task?.revision ?? 1}${rationale ? ` (${rationale})` : ''}. Re-apply your work on top of the new direction.`]
  } else if (round !== null && round.outcome === 'fail') {
    failingChecks = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'failure')
      .map(check => ({ name: check.name, conclusion: check.conclusion, link: check.link }))
    const all = changeRow.taskId === null ? [] : deps.tasks.store.results.findingsFor(round.resultId)
    const findings = round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all
    findingsIds = findings.map(row => row.id)
    findingsTexts = findings.map(row => row.findings)
  }
  await dispatchFix(deps, {
    executionId: input.executionId, change: input.change, group: input.group,
    failingChecks, findingsIds, findingsTexts,
    continueFrom: round?.commitSha ?? changeRow.baselineCommit ?? '',
    fixRounds: changeRow.fixRounds,
  }, { id: newest.id, number: newest.number, manifestHash: newest.manifestHash })
}

/**
 * Retry of a failed or closed stage (D12): the stage's instruction is sent
 * again. The task's newest standing assignment is re-sent verbatim to the
 * same target under a key carrying the change's new generation — a handoff
 * through the result service (a review re-pins the round's review), else a
 * plain dispatch. A change without one dispatches its implement attempt.
 * The step clears once the instruction is sent.
 */
export async function redispatchStage(deps: DispatchDeps, row: { executionId: string; change: string; taskId: string | null; generation: number }): Promise<void> {
  const execution = deps.executions.execution(row.executionId)
  if (execution === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const caller = kawaiCaller(deps.team, row.executionId)
  const previous = row.taskId === null ? undefined
    : deps.tasks.store.assignmentsOf(row.taskId).filter(entry => entry.supersededBy === null).at(-1)
  if (row.taskId !== null && previous !== undefined) {
    const taskId = row.taskId
    const target = { kind: previous.targetKind, id: previous.targetId }
    const roleProfiles = previous.targetKind === 'group' ? revision?.content.roles.find(role => role.group === previous.targetId)?.profiles ?? [] : []
    const requestKey = `${previous.requestKey}:retry:${row.generation}`
    const handoffKind = previous.handoffKind ?? null
    const resultId = previous.resultId ?? null
    if (handoffKind !== null && resultId !== null) {
      const outcome = await refusable(handoffKind, () => deps.results.handoff(caller, taskId, {
        kind: handoffKind, resultId, target, instructions: previous.instruction, requestKey,
        ...(previous.expectedResponse ? { expectedResponse: previous.expectedResponse } : {}),
        ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
      }))
      const round = deps.executions.rounds(row.executionId, row.change).at(-1) ?? null
      if (handoffKind === 'review' && round !== null) deps.executions.setRoundReview(round.id, outcome.assignment.id)
    } else {
      // The earlier instruction may still be outstanding (claimed or
      // delivered before a hand close, or unscoped group mail the close
      // left queued): the resend supersedes it through the stop branch,
      // which cancels it only while it is still queued.
      await refusable('implement', () => deps.assignments.dispatch(caller, {
        taskId, target, instruction: previous.instruction, requestKey, handling: 'stop',
        ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
      }))
    }
  } else {
    const group = revision?.content.changes.find(entry => entry.change === row.change)?.group ?? null
    if (group !== null) await dispatchImplementAttempt(deps, { executionId: row.executionId, change: row.change, group })
  }
  const fresh = deps.executions.change(row.executionId, row.change)
  if (fresh !== null && fresh.step === 'redispatch') deps.executions.transition(row.executionId, row.change, fresh, { step: null })
}

/** The integration branch an execution lands on (D12), named in its instructions; null under direct landing. */
function integrationBranchOf(execution: { landingMode: string; baseBranch: string }): string | null {
  return execution.landingMode === 'integration-branch' ? execution.baseBranch : null
}
