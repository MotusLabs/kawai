// Kawai's task creation and the implement dispatch (plan-execution D7/D8,
// §11.4). The system TaskCaller is minted HERE and nowhere else (D2): the
// constructor below is module-private, so no tool handler or WebSocket
// connection path can build one. The whole step is idempotent the way its
// pieces are: the task exists or is created, the attempt row exists or is
// inserted, and the dispatch replays by its request key
// `exec:<execution>:<change>:attempt:<n>:<generation>` — a restart between
// the pieces resumes without a second instruction. The task's revision 1
// carries the contract read from the change's design.md at the baseline
// commit (implementation-contract D4), or is journaled as having none.
import { implementTaskText } from './taskText'
import { createHash } from 'node:crypto'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { SystemCaller } from '../../team/systemCaller'
import type { AssignmentService } from '../../team/AssignmentService'
import type { TaskResultService } from '../../team/TaskResultService'
import { runGitAsync } from '../../git/gitCommand'
import { dispatchOwedFix, dispatchOwedUpdate } from './owedFix'
import { attemptStatus } from './attemptStatus'
import type { RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { fixInstruction, implementInstruction, updateInstruction } from './instructions'
import { fixFindings, type FixFindings } from './fixFindings'
import { refusable, refusalOf, StepRefusal } from './stepRefusal'
import { renderContract } from '../../../shared/implementationContract'
import { gitShowFile, snapshotContract, type ShowFile } from './contractSnapshot'
import { currentOwedRow } from './owedSuccessor'
import { commitAttemptInsert, commitAttemptSend, fixHandoffWithin, routeOf, type SendContext } from './attemptSend'

/** The system caller (D2): minted only inside this module. */
function kawaiCaller(team: TeamIdentity, executionId: string): SystemCaller {
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
  /** The contract snapshot's git read (implementation-contract D4); the real `git show` by default. */
  showFile?: ShowFile
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
 * and the dispatch replays under its request key. The execution's revision
 * is read once and re-checked after each await: an Apply that commits while
 * the contract or git reads run moves the execution on, so this pass writes
 * nothing more and the next tick starts again from the stored rows (review
 * F1). The attempt, its dispatch, and the stamp commit in one transaction
 * that checks the revision first, so a manifest always names the revision
 * current when its assignment commits (A7, P4).
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
  const moved = (): boolean => {
    const fresh = deps.executions.execution(input.executionId)
    return fresh === null || fresh.state !== 'running' || fresh.revision !== execution.revision || fresh.contentHash !== execution.contentHash
  }

  // The task (D7): title, direction, acceptance, worktree, openspec link, plan link.
  let taskId = changeRow.taskId
  if (taskId === null) {
    // The contract at the baseline, read once (implementation-contract D4, E1–E5); never re-derived.
    const snapshot = await snapshotContract(deps.showFile ?? gitShowFile, changeRow.worktree, changeRow.baselineCommit, input.change)
    if (moved()) return
    const task = await refusable('implement', () => deps.tasks.create(kawaiCaller(deps.team, input.executionId), {
      title: `${input.change} — ${deps.plans.get(execution.planId)?.title ?? execution.planId}`,
      ...implementTaskText(entry, revision.content),
      worktree: changeRow.worktree,
      openspec_change: input.change,
      plan_id: execution.planId,
      plan_change: input.change,
      ...(snapshot.contract ? { contract: renderContract(snapshot.contract) } : {}),
    }))
    if (snapshot.journal !== null) deps.tasks.store.appendJournal(task.id, { kind: 'system', sessionId: null }, snapshot.journal)
    taskId = task.id
    deps.executions.transition(input.executionId, input.change, { state: changeRow.state, generation: changeRow.generation }, { taskId })
  }

  // The attempt and its immutable manifest (D8), then the keyed dispatch.
  // H4 in the dispatch itself (revision-control PR E, A3): the implement step
  // mints and dispatches only when no attempt row exists. With rows present
  // it writes and sends nothing — an undispatched row belongs to the owed
  // step, and a human Retry re-sends through redispatchStage under :retry:,
  // never a second implement dispatch beside the rows.
  if (deps.executions.attempts(input.executionId, input.change).length > 0) return
  const read = { newestId: null, roundId: deps.executions.rounds(input.executionId, input.change).at(-1)?.id ?? null, taskRevision: deps.tasks.store.get(taskId)?.revision ?? 1 }
  const head = await runGitAsync(['rev-parse', 'HEAD'], { cwd: changeRow.worktree })
  const headSha = head.stdout.trim()
  const startCommit = head.ok ? headSha : changeRow.baselineCommit
  const files = await runGitAsync(['ls-tree', '-r', '--name-only', startCommit], { cwd: changeRow.worktree })
  const artifacts = await artifactsAt(changeRow.worktree, startCommit, files.ok ? files.stdout.trim().split('\n').filter(Boolean) : [])
  const facts = { taskId, baseline: changeRow.baselineCommit, startCommit, artifacts }
  // AL2: the row and its send commit in one transaction, every pin, the
  // route, and the instruction taken from the rows re-read there; only the
  // git facts above crossed the awaits. A refused send keeps its row (owed,
  // the Retry's); the refusal surfaces after commit.
  let refusal: StepRefusal | null = null
  deps.executions.db.transaction(() => {
    if (moved() || deps.executions.attempts(input.executionId, input.change).length > 0) return
    const fresh = deps.plans.revision(execution.planId, execution.revision)
    const change = deps.executions.change(input.executionId, input.change)
    if (fresh === null || change === null || routeOf(fresh.content, change)?.group !== input.group) return
    const attempt = commitAttemptInsert(insertDeps(deps), { executionId: input.executionId, change: input.change, kind: 'implement' }, read, facts)
    if (attempt === null) return
    try {
      commitAttemptSend(sendDeps(deps), input, attempt.id, implementSend(deps, input.executionId, headSha))
    } catch (error) {
      refusal = refusalOf('implement', error)
    }
  })()
  if (refusal !== null) throw refusal
}

/** The implement instruction's keyed group dispatch, built from the send transaction's rows (AL2); `head` is the git fact. */
function implementSend(deps: DispatchDeps, executionId: string, head: string): (context: SendContext) => string {
  return context => deps.assignments.dispatchWithin(kawaiCaller(deps.team, executionId), {
    taskId: context.change.taskId, target: { kind: 'group', id: context.group },
    instruction: implementInstruction(context.base(head)), requestKey: context.requestKey, ...context.profiles,
  }).assignment.id
}

const sendDeps = (deps: DispatchDeps) => ({ executions: deps.executions, plans: deps.plans, tasks: deps.tasks.store })
const insertDeps = (deps: DispatchDeps) => ({ executions: deps.executions, plans: deps.plans, taskRevisionOf: (id: string) => deps.tasks.store.get(id)?.revision ?? null })

/** What a fix attempt names: the failed round's checks and findings, and where to continue. */
export interface FixAttemptInput {
  executionId: string
  change: string
  /** The caller's group: a precondition of the send, never written (AL2) — a send whose re-derived group differs yields. */
  group: string
  /** A Reassign's group, committed by the transition after the dispatch: the route's group until then (review-convergence decision 7). */
  reassign?: string | null
  failingChecks: Array<{ name: string; conclusion: string; link: string | null }>
  findingsIds: string[]
  /** review-findings-ledger D7: built by fixFindings from the fold. */
  findings: FixFindings
  continueFrom: string
  fixRounds: number
  /** A diagnosis outcome's rationale, which the fix handoff carries (review-convergence decision 7). */
  diagnosis?: string | null
  /** When set, the attempt is an update attempt (revision-control PR E, A1): its manifest records the failed branch update. */
  update?: { base: string; files: string[] }
}

/**
 * The fix attempt row (D12), created or reused; null when the change cannot
 * take one. Split from the dispatch so a hold can create the attempt — the
 * owed dispatch's marker (revision-control 3.2) — without sending the
 * handoff. The row's pins and route are taken at commit (AL2); only the git
 * facts cross the awaits.
 */
export async function ensureFixAttempt(deps: DispatchDeps, input: Omit<FixAttemptInput, 'group'> & { group?: string }): Promise<{ id: string; number: number; manifestHash: string } | null> {
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null || changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null || changeRow.taskId === null) return null
  const round = deps.executions.rounds(input.executionId, input.change).at(-1) ?? null
  const taskId = changeRow.taskId

  const existing = deps.executions.attempts(input.executionId, input.change)
  // An attempt answers one round — its manifest's answers.roundId. The
  // newest attempt of the asked kind is reused only while it answers the
  // round the change now stands on (the failed round, or the round a newer
  // task revision superseded): a later round owes its own attempt, so the
  // owed dispatch's marker — the outstanding assignment's request key — can
  // never settle a later round's debt with an earlier round's key
  // (revision-control 3.2, review B1). The same-round reuse stays: a
  // revision stage re-planned for a newer task revision must not mint an
  // attempt per tick, and a kind-'update' row never stands in for a fix (a
  // revision replacement of an update attempt mints its own fix row). A
  // reused row whose pins went stale is never sent: the send yields and the
  // owed step sends its successor (DC1).
  const kind = input.update === undefined ? 'fix' : 'update'
  const newest = existing.at(-1)
  if (newest !== undefined && newest.kind === kind && newest.manifest.answers !== undefined
    && newest.manifest.answers.roundId === round?.id) {
    return { id: newest.id, number: newest.number, manifestHash: newest.manifestHash }
  }
  // The pins this mint was decided on; the insert re-checks them after the git reads (invariant AL, review F6).
  const read = { newestId: newest?.id ?? null, roundId: round?.id ?? null, taskRevision: deps.tasks.store.get(taskId)?.revision ?? 1 }
  const head = await runGitAsync(['rev-parse', 'HEAD'], { cwd: changeRow.worktree })
  const startCommit = head.ok ? head.stdout.trim() : changeRow.baselineCommit
  const files = await runGitAsync(['ls-tree', '-r', '--name-only', startCommit], { cwd: changeRow.worktree })
  const artifacts = await artifactsAt(changeRow.worktree, startCommit, files.ok ? files.stdout.trim().split('\n').filter(Boolean) : [])
  return commitAttemptInsert(insertDeps(deps), { executionId: input.executionId, change: input.change, kind, reassign: input.reassign ?? null }, read, {
    taskId, baseline: changeRow.baselineCommit, startCommit, artifacts,
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
    ...(input.update !== undefined ? { update: input.update } : {}),
  })
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

/**
 * The keyed handoff of an existing fix attempt (D12): the instruction names
 * what it fixes. Exported for the gated fix step and the owed dispatch
 * (revision-control 3.2). A fix is a handoff (D7): it supersedes the
 * outstanding review through the stop branch, so a delivered review never
 * holds the change. A fix that answers no round — an adaptation's
 * (plan-pause Adapt, Apply's adapt) — has no result to hand off from: it is
 * a plain keyed dispatch, as the owed implement attempt's is. Either commits
 * with its stamp in the send transaction, its route, instruction, and key
 * built there (P4, AL2; reviews F1, F7).
 */
export async function dispatchFix(deps: DispatchDeps, input: FixAttemptInput, attempt: { id: string; number: number; manifestHash: string }): Promise<void> {
  const caller = kawaiCaller(deps.team, input.executionId)
  await refusable('fix', async () => commitAttemptSend(sendDeps(deps), input, attempt.id, context => {
    const instruction = fixInstruction({
      ...context.base(input.continueFrom),
      failingChecks: input.failingChecks,
      findings: input.findings,
      fixRounds: input.fixRounds,
      fixRoundLimit: context.execution.maxFailedFixRounds,
      diagnosis: input.diagnosis ?? null,
      continueFrom: input.continueFrom,
    })
    const { taskId } = context.change
    return context.round === null
      ? deps.assignments.dispatchWithin(caller, { taskId, target: { kind: 'group', id: context.group }, instruction, requestKey: context.requestKey, ...context.profiles }).assignment.id
      : fixHandoffWithin({ assignments: deps.assignments, store: deps.tasks.store }, caller, taskId, {
        resultId: context.round.resultId, group: context.group, instructions: instruction, requestKey: context.requestKey, ...context.profiles,
      }).id
  }))
}

/**
 * D13's update attempt (revision-control PR E, A1): the failed branch
 * update's fix handoff, carried by a kind-'update' attempt row minted here —
 * or reused when the newest row already answers the round (a re-run after a
 * refused send re-sends, it never mints twice) — and stamped with the
 * handoff's assignment. The key is the uniform
 * `exec:<execution>:<change>:attempt:<n>:<generation>`; the retired
 * `attempt:update:` shape named the round, which the row itself records now.
 * Nothing about the route is read before the mint's awaits: the send
 * transaction derives the group and profiles (AL2, review F7).
 */
export async function dispatchUpdateAttempt(deps: DispatchDeps, input: {
  executionId: string
  change: string
  round: RoundRow
  update: { base: string; files: string[] }
}): Promise<void> {
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null) return
  const attempt = await ensureFixAttempt(deps, {
    executionId: input.executionId, change: input.change,
    failingChecks: [], findingsIds: [], findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] },
    continueFrom: input.round.commitSha, fixRounds: changeRow.fixRounds,
    update: input.update,
  })
  if (attempt === null) return
  const caller = kawaiCaller(deps.team, input.executionId)
  await refusable('update', async () => commitAttemptSend(sendDeps(deps), input, attempt.id, context => fixHandoffWithin(
    { assignments: deps.assignments, store: deps.tasks.store }, caller, context.change.taskId, {
      resultId: input.round.resultId, group: context.group, requestKey: context.requestKey, ...context.profiles,
      instructions: updateInstruction(input.update, { revision: context.execution.revision, manifestHash: context.attempt.manifestHash }),
    }).id))
}

/**
 * The owed dispatch of a released hold or a refused send (revision-control
 * 3.2, PR E A1/H1): the newest attempt row is owed — never dispatched, no
 * round answers it — and this step is its one writer beside the fixes step
 * (H″ O2). The instruction is rebuilt from the row's manifest and the round
 * it answers (a superseded round names the republished direction, a failed
 * round its failing checks and the verdict's findings, an update its failed
 * branch update), and the dispatch goes out once under the attempt's own
 * request key: a re-run replays it, and once sent the assignment carries the
 * key, so nothing is owed again. The planner's `group` is a precondition
 * only (AL2): the send re-derives it.
 */
export async function dispatchOwedAttempt(deps: DispatchDeps, input: { executionId: string; change: string; group: string }): Promise<void> {
  const owedRow = deps.executions.attempts(input.executionId, input.change).at(-1)
  if (owedRow === undefined) return
  // DC1: a row whose pins went stale (an Apply moved the execution on, or its route's profiles moved) is never sent; its successor is.
  const newest = currentOwedRow({ executions: deps.executions, plans: deps.plans, taskRevisionOf: taskId => deps.tasks.store.get(taskId)?.revision ?? null }, input, owedRow)
  if (newest === null) return
  if (newest.kind === 'update') return dispatchOwedUpdate(deps, input, newest)
  if (newest.kind === 'fix') return dispatchOwedFix(deps, input, newest)
  // The implement attempt's re-send (A1): the row was minted, its dispatch never committed.
  await refusable('implement', async () => commitAttemptSend(sendDeps(deps), input, newest.id, implementSend(deps, input.executionId, newest.manifest.startCommit)))
}

/**
 * Retry of a failed or closed stage (D12): the stage's instruction is sent
 * again, in A3's order (revision-control PR E). An owed newest row is the
 * change's next instruction and the owed step — never this stage — sends it
 * (H″ O2; the step still clears, and the planner's `continue` keeps the two
 * stages out of one pass). Else the task's standing assignment re-sends
 * verbatim to the same target under a key carrying the change's new
 * generation — a handoff through the result service (a review re-pins the
 * round's review), else a plain dispatch. Else, when no assignment stands
 * but the newest row is linked (the pause stop-branch superseded the chain),
 * that row's own assignment re-sends under the same :retry: shape. A change
 * with no linked row dispatches its implement attempt (a no-op behind H4's
 * guard when rows exist). The step clears once the decision is applied.
 */
export async function redispatchStage(deps: DispatchDeps, row: { executionId: string; change: string; taskId: string | null; generation: number; groupOverride: string | null }): Promise<void> {
  const execution = deps.executions.execution(row.executionId)
  if (execution === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const caller = kawaiCaller(deps.team, row.executionId)
  const newest = deps.executions.attempts(row.executionId, row.change).at(-1) ?? null
  const assignments = row.taskId === null ? [] : deps.tasks.store.assignmentsOf(row.taskId)
  // A3 case 1: an owed newest row reads noActiveWork for a pause and no
  // redispatch here; the owed step dispatches it exactly once, next pass.
  const owed = newest !== null && row.taskId !== null
    && attemptStatus(newest, assignments, deps.executions.rounds(row.executionId, row.change)) === 'owed'
  if (!owed) {
    // A3 case 2: the standing chain's tip re-sends.
    const previous = assignments.filter(entry => entry.supersededBy === null).at(-1)
    // A3 case 3: the chain is gone, but the newest row is linked — its own
    // assignment is what went out for this attempt, so it re-sends.
    const linked = previous === undefined && newest !== null && newest.assignmentId !== null
      ? assignments.find(entry => entry.id === newest.assignmentId)
      : undefined
    const source = previous ?? linked
    if (row.taskId !== null && source !== undefined) {
      const taskId = row.taskId
      const target = { kind: source.targetKind, id: source.targetId }
      // AL2 holds here without a transaction: the profiles are read in the
      // same macrotask as the durable write. A system caller's group handoff
      // or dispatch awaits only resolved promises before it commits
      // (TaskService.context, AssignmentService.teamOf and sessionTarget
      // return synchronously for it), so no Apply runs in between; a session
      // target, whose dispatch does await a git read, carries no profiles.
      const roleProfiles = source.targetKind === 'group' ?revision?.content.roles.find(role => role.group === source.targetId)?.profiles ?? [] : []
      const requestKey = `${source.requestKey}:retry:${row.generation}`
      const handoffKind = source.handoffKind ?? null
      const resultId = source.resultId ?? null
      if (handoffKind !== null && resultId !== null) {
        const outcome = await refusable(handoffKind, () => deps.results.handoff(caller, taskId, {
          kind: handoffKind, resultId, target, instructions: source.instruction, requestKey,
          ...(source.expectedResponse ? { expectedResponse: source.expectedResponse } : {}),
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
          taskId, target, instruction: source.instruction, requestKey, handling: 'stop',
          ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
        }))
      }
    } else {
      const group = row.groupOverride ?? revision?.content.changes.find(entry => entry.change === row.change)?.group ?? null
      if (group !== null) await dispatchImplementAttempt(deps, { executionId: row.executionId, change: row.change, group })
    }
  }
  const fresh = deps.executions.change(row.executionId, row.change)
  if (fresh !== null && fresh.step === 'redispatch') deps.executions.transition(row.executionId, row.change, fresh, { step: null })
}
