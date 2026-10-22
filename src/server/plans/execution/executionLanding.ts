// Direct landing (plan-execution D13, §14): a passed change resolves its
// acceptance conditions, takes the team's one landing slot, is brought up to
// date with its base (a clean GitHub update carries the round onto the new
// head; a conflict returns the change as an update attempt naming the
// files), and merges with the reviewed head pinned. The landing fact records
// the re-read base and whether the merge commit's tree is the reviewed
// merge's tree; the task is accepted as Kawai; the worktree is removed only
// when clean and unoccupied; base-branch CI lands as evidence. When the last
// change lands the execution completes and the plan completes as the system.
import path from 'node:path'
import fs from 'node:fs'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskResultService } from '../../team/TaskResultService'
import type { EffectAdapter, EffectCallResult } from './effects'
import type { ChangeRow, EffectRow, ExecutionRow, RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import type { PlanService } from '../PlanService'
import { isAncestor, mergeTree, gitFetch, lsRemoteHead, worktreeRemove } from '../landing/gitRemote'
import { ghPrMerge, ghPrView, ghUpdateBranch } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { MergeMethod } from '../../../shared/planExecution'
import { runGit } from '../../git/gitCommand'
import { logger } from '../../logger'
import { refusable } from './stepRefusal'
import { ExecutionConflict } from './executionPatch'
import { EffectPinConflict } from './executionEffectStore'
import { cleanMergeCheck } from '../landing/cleanMerge'

export interface LandingDeps {
  team: TeamIdentity
  repo: string
  executions: ExecutionStore
  plans: PlanStore
  /** Kawai accepts the landed change's result through it (D13 step 5). */
  results: TaskResultService
  /** The plan service, for the system completion (D19). */
  plansService: PlanService
  ghOptions?: GhCommandOptions
  /** Unresolved acceptance-gated conditions of the execution, read live (D13 step 1). */
  conditionsOf: (executionId: string) => string[]
  /** Live session records: a worktree with a live session is never removed. */
  records: () => Iterable<{ sessionId: string; projectPath: string; archivedAt?: string | null }>
  now: () => string
  /**
   * D9 within D13: once a failed branch update settles, a newer task revision
   * replaces the update attempt with its own fix attempt naming the base head
   * and files. Resolves false when no revision is pending.
   */
  revisionAttempt: (changeRow: { executionId: string; change: string; taskId: string | null }, round: RoundRow, update: { base: string; files: string[] }) => Promise<boolean>
  /** The task's live status: a task the human closed is never touched again (D19). */
  taskStatusOf: (taskId: string) => string | null
  /** The hold gate (revision-control 3.2): true when the change is held. */
  gate?: (change: string) => boolean
}

/** The landing stage's git/gh reads, injectable for tests. */
export interface LandingAdapters {
  fetch: typeof gitFetch
  isAncestor: typeof isAncestor
  mergeTree: typeof mergeTree
  lsRemoteHead: typeof lsRemoteHead
  prMerge: typeof ghPrMerge
  prView: typeof ghPrView
  updateBranch: typeof ghUpdateBranch
}

export const landingAdapters: LandingAdapters = {
  fetch: gitFetch, isAncestor, mergeTree, lsRemoteHead, prMerge: ghPrMerge, prView: ghPrView, updateBranch: ghUpdateBranch,
}

/**
 * One landing tick for a passed change (D13). The change is `gating` with a
 * passed round, or `landing` mid-flight; every stop and every exit from
 * `landing` releases the slot (the store's rule).
 */
export async function applyLanding(deps: LandingDeps, adapters: LandingAdapters, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null; prNumber: number | null; state: string; step: string | null; taskId: string | null }, round: RoundRow,
  finish?: LandingFinish, baseMissing?: (row: ChangeRow) => void): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)
  if (execution === null || changeRow.branch === null) return
  // A held change enters no landing stage and takes no slot (revision-control
  // 3.2): the release re-fires the stage from the gating state.
  if (deps.gate?.(changeRow.change) === true) return

  if (changeRow.state === 'gating') {
    // Step 1 — Conditions: an unresolved acceptance condition holds the
    // change outside the slot (D13).
    const unresolved = deps.conditionsOf(changeRow.executionId)
    if (unresolved.length > 0) {
      const fresh = store.change(changeRow.executionId, changeRow.change)!
      if (fresh.step !== 'conditions') store.transition(changeRow.executionId, changeRow.change, fresh, { step: 'conditions' })
      return
    }
    // Step 2 — Slot: entering `landing` takes the team's slot; a taken slot
    // waits for the next tick.
    const fresh = store.change(changeRow.executionId, changeRow.change)!
    try {
      store.transition(changeRow.executionId, changeRow.change, fresh, { state: 'landing', step: 'up-to-date' })
    } catch (error) {
      if (!(error instanceof ExecutionConflict) || error.kind !== 'slot-taken') throw error
      // Slot taken: the change waits, named so the view explains it (D17).
      const waiting = store.change(changeRow.executionId, changeRow.change)!
      if (waiting.step !== 'awaiting-slot') store.transition(changeRow.executionId, changeRow.change, waiting, { step: 'awaiting-slot' })
      return
    }
    changeRow = { ...changeRow, state: 'landing', step: 'up-to-date' }
  }

  if (changeRow.state !== 'landing') return

  // Step 3 — Up to date: the branch head on origin contains the base head.
  const baseRef = `refs/heads/${execution.baseBranch}`
  const headRef = `refs/heads/${changeRow.branch}`
  const head = await adapters.lsRemoteHead(changeRow.worktree ?? deps.team.groupsRoot, headRef)
  if (!head.ok || head.sha === null) return
  const base = await adapters.lsRemoteHead(changeRow.worktree ?? deps.team.groupsRoot, baseRef)
  if (!base.ok) return
  // An absent base (a read that answered): the mechanism decides; direct keeps waiting as before.
  if (base.sha === null) return baseMissing?.(store.change(changeRow.executionId, changeRow.change)!)
  // Both heads may exist only on origin (a merge on GitHub, another push):
  // fetch them before any local ancestry or merge read.
  if (!(await fetchHeads(adapters, changeRow.worktree ?? deps.team.groupsRoot, [baseRef, headRef]))) return
  const contains = await adapters.isAncestor(changeRow.worktree ?? deps.team.groupsRoot, base.sha, head.sha)
  if (!contains.ok) return
  if (!contains.ancestor) {
    // The base moved into the branch's future: predict the merge.
    const prediction = await adapters.mergeTree(changeRow.worktree ?? deps.team.groupsRoot, head.sha, base.sha)
    if (!prediction.ok) return
    if (prediction.conflicts.length > 0) {
      // A conflict releases the slot (leaving `landing`) and dispatches an
      // update attempt naming the files. `passedAt` clears: the round's
      // pass waits on the attempt's new result. No hold branch here: the
      // gate at the top of applyLanding returns before the stage logic, so
      // a held change never predicts a merge — a held holder's settling
      // update-branch effect keeps `passedAt` in failedUpdate below, which
      // applyLandingOutcome reaches under a hold.
      const fresh = store.change(changeRow.executionId, changeRow.change)!
      store.transition(changeRow.executionId, changeRow.change, fresh, { state: 'gating', step: null, stopReason: null, stopDetail: null, passedAt: null })
      return dispatchUpdateAttempt(deps, changeRow, round, { kind: 'conflict', files: prediction.conflicts, base: base.sha })
    }
    // Clean: the update-branch effect runs, pinned to the reviewed head.
    // The pre-guard (A1): a live landing-kind row of another identity —
    // another round or kind — settles first; the step stays and the next
    // tick re-reads. The same identity is inserted and adopted (A1).
    const fresh = store.change(changeRow.executionId, changeRow.change)!
    const live = store.liveLandingEffect(changeRow.executionId, changeRow.change)
    if (live !== null && !(live.kind === 'update-branch' && live.roundId === round.id)) return
    try {
      store.insertEffect({
        executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'update-branch',
        effectKey: `${changeRow.executionId}:${changeRow.change}:update-branch:${round.number}:${fresh.generation}`,
        command: { repo: deps.repo, pr: changeRow.prNumber ?? 0, head: head.sha },
      })
    } catch (error) {
      // A1: a live row of this identity with a different command decides
      // first — the step stays where it is, and the next tick re-reads.
      if (!(error instanceof EffectPinConflict)) throw error
      return
    }
    store.transition(changeRow.executionId, changeRow.change, fresh, { step: 'updating' })
    return
  }

  // Step 4 — Merge: pinned to the reviewed head (or the carried head). A
  // mechanism with its own final step (integration's fast-forward) runs it instead.
  if (finish !== undefined) return finish(store.change(changeRow.executionId, changeRow.change)!, { execution, head: head.sha, base: base.sha, cwd: changeRow.worktree ?? deps.team.groupsRoot })
  const fresh = store.change(changeRow.executionId, changeRow.change)!
  if (fresh === null || fresh.step === 'merging') return
  // The pre-guard (A1): a live landing-kind row of another identity settles
  // first — the step stays and the next tick re-reads. The same identity is
  // inserted and adopted (A1).
  const live = store.liveLandingEffect(changeRow.executionId, changeRow.change)
  if (live !== null && !(live.kind === 'merge' && live.roundId === round.id)) return
  // The insert lands before the step transition: a refused insert (A1) never
  // flips the step — the live row settles first, and the next tick re-reads.
  try {
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'merge',
      effectKey: `${changeRow.executionId}:${changeRow.change}:merge:${round.number}:${fresh.generation}`,
      command: { repo: deps.repo, pr: changeRow.prNumber ?? 0, head: head.sha, base: base.sha, baseBranch: execution.baseBranch, method: execution.mergeMethod, cwd: changeRow.worktree ?? deps.team.groupsRoot },
    })
  } catch (error) {
    if (!(error instanceof EffectPinConflict)) throw error
    return
  }
  store.transition(changeRow.executionId, changeRow.change, fresh, { step: 'merging' })
}

/** A mechanism's final landing step, once the change is up to date: its head and the base head it contains. */
export type LandingFinish = (row: ChangeRow, at: { execution: ExecutionRow; head: string; base: string; cwd: string }) => Promise<void>

/** Fetch origin's refs into the object store; false when a fetch failed (the stage is due again). */
async function fetchHeads(adapters: Pick<LandingAdapters, 'fetch'>, cwd: string, refs: string[]): Promise<boolean> {
  for (const ref of refs) {
    const fetched = await adapters.fetch(cwd, 'origin', ref)
    if (!fetched.ok) return false
  }
  return true
}

/**
 * A branch update that did not produce a clean base merge (D13): the change
 * leaves the slot for gating, and one attempt answers it — the revision's fix
 * attempt when a newer task revision waited for the update (D9), else the
 * update attempt naming the files, or the failed check when none conflict.
 */
async function failedUpdate(deps: LandingDeps, row: ChangeRow, updateRound: RoundRow | null, update: { base: string; files: string[] }): Promise<void> {
  const store = deps.executions
  // Under a hold (revision-control 3.2) `passedAt` is kept and no attempt
  // dispatches — no owed marker for the update path: the release re-fires
  // the landing stage, which re-runs the update and re-derives the attempt.
  const held = deps.gate?.(row.change) === true
  store.transition(row.executionId, row.change, row, { state: 'gating', step: null, ...(held ? {} : { passedAt: null }) })
  if (held) return
  const round = updateRound ?? store.rounds(row.executionId, row.change).at(-1) ?? null
  if (round === null) return
  if (await deps.revisionAttempt(row, round, update)) return
  await dispatchUpdateAttempt(deps, row, round, update.files.length > 0 ? { kind: 'conflict', files: update.files, base: update.base } : { kind: 'failed-check' })
}

/** D13's update attempt: a fix handoff naming the conflict or the failed update. */
async function dispatchUpdateAttempt(deps: LandingDeps, changeRow: { executionId: string; change: string; taskId: string | null }, round: RoundRow, detail: { kind: 'conflict'; files: string[]; base: string } | { kind: 'failed-check' }): Promise<void> {
  if (changeRow.taskId === null) return
  const taskId = changeRow.taskId
  const files = detail.kind === 'conflict' ? detail.files : []
  const base = detail.kind === 'conflict' ? detail.base : ''
  // The update attempt goes to the change's implementing group (D13).
  const execution = deps.executions.execution(changeRow.executionId)
  const revision = execution === null ? null : deps.plans.revision(execution.planId, execution.revision)
  const group = revision?.content.changes.find(entry => entry.change === changeRow.change)?.group ?? null
  if (group === null) return
  const roleProfiles = revision?.content.roles.find(role => role.group === group)?.profiles ?? []
  const generation = deps.executions.change(changeRow.executionId, changeRow.change)?.generation ?? 0
  await refusable('update', () => deps.results.handoff({ kind: 'system', team: deps.team, origin: { kind: 'execution', executionId: changeRow.executionId } }, taskId, {
    kind: 'fix', resultId: round.resultId, target: { kind: 'group', id: group },
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
    instructions: [
      `Bring the branch up to date with the base branch.`,
      detail.kind === 'conflict'
        ? `The merge conflicts with the base${base ? ` (base head ${base})` : ''} in: ${files.join(', ')}. Resolve the conflicts and commit the merge.`
        : `GitHub's branch update did not produce a clean merge. Merge the base branch yourself and push.`,
      `Then submit a new result with task_submit_result.`,
    ].join('\n\n'),
    requestKey: `exec:${changeRow.executionId}:${changeRow.change}:attempt:update:${round.number}:${generation}`,
  }))
}

/** The update-branch effect: GitHub merges the base into the PR, pinned to the reviewed head. */
/** The update-branch effect keeps its gh call behind the adapters so tests stub it like every other. */
export function updateBranchAdapter(adapters: LandingAdapters, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const pr = Number(command.pr ?? 0)
      const head = String(command.head ?? '')
      const result = await adapters.updateBranch(repo, pr, head, ghOptions)
      // GitHub answers a conflicting update — or a head that moved past the
      // pin — with 422: the update settles as not merged (D13), and the
      // follow-on dispatches the attempt that answers it.
      if (!result.ok && 'httpStatus' in result.error && result.error.httpStatus === 422) {
        return { ok: true, outcome: { requested: false, conflict: true, head, message: result.error.message } }
      }
      if (!result.ok) return { ok: false, error: result.error }
      return { ok: true, outcome: { requested: true, head } }
    },
  }
}

/** The remove-worktree effect (D13 step 6): never forced; the stage only inserts it when clean and unoccupied. */
export function removeWorktreeAdapter(): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const path = String(effect.command.path ?? '')
      const removed = await worktreeRemove(String(effect.command.repo ?? ''), path)
      if (!removed.ok) return { ok: false, error: removed.error }
      return { ok: true, outcome: { removed: path } }
    },
  }
}

/** The merge effect: base re-read, the pinned merge, the merge commit (D13 step 4). */
export function mergeAdapter(adapters: LandingAdapters, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const pr = Number(command.pr ?? 0)
      const head = String(command.head ?? '')
      const cwd = String(command.cwd ?? '')
      // The pre-merge base re-read: a base that moved returns the change to
      // the up-to-date step (the executor's done handler sees baseMoved).
      const baseRef = `refs/heads/${String(command.baseBranch ?? 'master')}`
      const base = await adapters.lsRemoteHead(cwd, baseRef)
      if (!base.ok || base.sha === null) return { ok: false, error: { argv: ['git', 'ls-remote'], exitCode: 1, stderr: 'the base could not be read' } }
      const fetched = await adapters.fetch(cwd, 'origin', baseRef)
      if (!fetched.ok) return { ok: false, error: fetched.error }
      const contains = await adapters.isAncestor(cwd, base.sha, head)
      if (!contains.ok || !contains.ancestor) {
        return { ok: true, outcome: { merged: false, baseMoved: true, base: base.sha } }
      }
      // A8(ii): the pin is the base the clean-merge check saw, carried by
      // the direct landing's merge command (`base`). A base that moved or
      // was rewritten past it never merges — the outcome sends the change
      // back to the up-to-date step, which re-checks and re-pins. A command
      // without a pin (the promotion's merge, which verifies its target at
      // its own re-read step) skips this check.
      if (typeof command.base === 'string' && command.base !== '' && base.sha !== command.base) {
        return { ok: true, outcome: { merged: false, baseMoved: true, base: base.sha } }
      }
      // The execution's merge method (D16), snapshotted at Start.
      const method = String(command.method ?? 'merge') as MergeMethod
      const merged = await adapters.prMerge(repo, pr, method, head, ghOptions)
      if (!merged.ok) return { ok: false, error: merged.error }
      const view = await adapters.prView(repo, pr, ghOptions)
      if (!view.ok) return { ok: false, error: view.error }
      if (view.data.state !== 'MERGED' || view.data.mergeCommit === null) {
        return { ok: true, outcome: { merged: false, baseMoved: false, base: base.sha } }
      }
      return { ok: true, outcome: { merged: true, mergeCommit: view.data.mergeCommit, base: base.sha, head } }
    },
  }
}

/**
 * A done merge or update effect's follow-on (D13): a base move returns the
 * change to the up-to-date step keeping the slot; a completed merge writes
 * the landing fact, accepts the task as Kawai, removes the worktree when
 * safe, and completes the execution and the plan when everything landed.
 */
export async function applyLandingOutcome(deps: LandingDeps, effect: { kind: string; change: string | null; executionId: string; roundId?: string | null; outcome: unknown }, adapters: LandingAdapters = landingAdapters): Promise<void> {
  const store = deps.executions
  if (effect.change === null) return
  const outcome = effect.outcome as { merged?: boolean; baseMoved?: boolean; base?: string; mergeCommit?: string; head?: string; requested?: boolean; conflict?: boolean } | null
  const row = store.change(effect.executionId, effect.change)
  if (row === null || row.state !== 'landing') return

  if (effect.kind === 'update-branch') {
    // Poll the PR head: moved → the clean-merge check; not yet → wait.
    const execution = store.execution(effect.executionId)!
    const head = await adapters.lsRemoteHead(row.worktree ?? deps.team.groupsRoot, `refs/heads/${row.branch!}`)
    if (!head.ok || head.sha === null) return
    const view = await adapters.prView(deps.repo, row.prNumber ?? 0, deps.ghOptions)
    if (!view.ok) return
    const fresh = store.change(effect.executionId, effect.change)!
    const reviewedHead = String((effect.outcome as { head?: string } | null)?.head ?? '')
    const updateRound = effect.roundId !== null && effect.roundId !== undefined ? store.round(effect.roundId) : null
    // A human close while the update ran (D19): the update has settled, so
    // the change stops unless the update came through clean — then its
    // carried round is recorded first and the planner stops it. Nothing
    // waits on GitHub or dispatches an update attempt for a closed task.
    const status = row.taskId === null ? null : deps.taskStatusOf(row.taskId)
    const closed = status === 'done' || status === 'cancelled'
    const stopClosed = () => {
      store.transition(effect.executionId, effect.change!, fresh, {
        state: 'stopped', stopReason: 'task-closed', step: null,
        stopDetail: { message: `The task was ${status} by hand while the branch update ran; nothing merges.`, resumeState: 'landing', ...(row.taskId !== null ? { taskId: row.taskId } : {}) },
      })
    }
    if (outcome?.conflict === true) {
      if (closed) return stopClosed()
      // GitHub refused the update: the slot is released and the conflicting
      // files, predicted against the base head now, name the attempt.
      const cwd = row.worktree ?? deps.team.groupsRoot
      const baseRef = `refs/heads/${execution.baseBranch}`
      const base = await adapters.lsRemoteHead(cwd, baseRef)
      if (!base.ok || base.sha === null) return
      if (!(await fetchHeads(adapters, cwd, [baseRef]))) return
      const prediction = await adapters.mergeTree(cwd, reviewedHead, base.sha)
      if (!prediction.ok) return
      return failedUpdate(deps, fresh, updateRound, { base: base.sha, files: prediction.conflicts })
    }
    if (view.data.headRefOid === reviewedHead) {
      if (closed) return stopClosed()
      return // not moved yet
    }
    // The clean-merge check (cleanMerge.ts): parents [H, B'], the base contains B', the tree is merge-tree H B'.
    const checked = await cleanMergeCheck(adapters, { cwd: row.worktree ?? deps.team.groupsRoot, baseBranch: execution.baseBranch, branch: row.branch!, reviewedHead, updatedHead: view.data.headRefOid })
    if (checked === null) return
    if (checked.clean) {
      // The carried round: CI runs on the new head (D13).
      const round = effect.roundId !== null && effect.roundId !== undefined ? store.round(effect.roundId) : null
      if (round !== null) {
        // A7: an open prior round superseded by the carried one loses its
        // live round-effect rows with it.
        const prior = store.rounds(effect.executionId, effect.change).at(-1) ?? null
        store.insertCarriedRound({
          executionId: effect.executionId, change: effect.change, attemptId: round.attemptId,
          resultId: round.resultId, commitSha: view.data.headRefOid, carriedFrom: round.id, ciWindowFrom: deps.now(),
        })
        if (prior !== null && prior.outcome === null) store.cancelLiveRoundEffects(effect.executionId, prior.id)
        store.transition(effect.executionId, effect.change, fresh, { step: 'up-to-date', passedAt: null })
      }
      return
    }
    if (closed) return stopClosed()
    return failedUpdate(deps, fresh, updateRound, { base: checked.base, files: [] })
  }

  if (effect.kind === 'merge' && outcome !== null) {
    if (outcome.merged !== true) {
      // baseMoved: back to the up-to-date step, keeping the slot.
      store.transition(effect.executionId, effect.change, row, { step: 'up-to-date' })
      return
    }
    const execution = store.execution(effect.executionId)!
    const mergeCommit = String(outcome.mergeCommit ?? '')
    const head = String(outcome.head ?? '')
    // tree_verified: the merge commit's tree equals the reviewed head's
    // tree. The merge commit lives on origin: fetch the base first.
    await adapters.fetch(row.worktree ?? deps.team.groupsRoot, 'origin', `refs/heads/${execution.baseBranch}`)
    const mergeTree_ = await runGit(['rev-parse', `${mergeCommit}^{tree}`], { cwd: row.worktree ?? deps.team.groupsRoot })
    const headTree = await runGit(['rev-parse', `${head}^{tree}`], { cwd: row.worktree ?? deps.team.groupsRoot })
    const treeVerified = mergeTree_.ok && headTree.ok && mergeTree_.stdout.trim() === headTree.stdout.trim()
    store.insertLanding({
      planId: execution.planId, change: effect.change, executionId: effect.executionId, teamId: execution.teamId,
      mechanism: 'direct', prNumber: row.prNumber, prUrl: row.prUrl,
      headSha: head, baseSha: String(outcome.base ?? ''), mergeSha: mergeCommit, treeVerified,
    })
    store.transition(effect.executionId, effect.change, row, { state: 'landed', step: null })
    await afterLanded(deps, row, effect.executionId, head)
  }
}

/**
 * After a landing fact (D13 step 5, shared with integration's fast-forward):
 * Kawai accepts the round's result, removes the worktree when safe, and
 * completes the execution and the plan when everything landed. `row` is the
 * change as it was before it landed.
 */
export async function afterLanded(deps: LandingDeps, row: ChangeRow, executionId: string, head: string): Promise<void> {
  const store = deps.executions
  const execution = store.execution(executionId)
  if (execution === null) return
  // A7: the landing fact is written — a live landing-kind row of the change
  // (a sibling update-branch, a Retry's re-opened merge) never decides after
  // it. The settled done merge that landed this change is untouched (O3).
  store.cancelLiveLandingEffects(executionId, row.change)
  // Kawai accepts the landed change's result (idempotent per result) —
  // unless the human closed the task while the merge ran (D19): Kawai
  // never accepts again nor changes its status.
  const status = row.taskId === null ? null : deps.taskStatusOf(row.taskId)
  if (row.taskId !== null && status !== 'done' && status !== 'cancelled') {
    const round = store.rounds(executionId, row.change).find(entry => entry.commitSha === head) ?? null
    if (round !== null) {
      // The change is landed whatever the acceptance says; a refused
      // acceptance is logged and the task stays for the human to close.
      await deps.results.accept({ kind: 'system', team: deps.team, origin: { kind: 'execution', executionId } }, row.taskId, round.resultId)
        .catch(error => logger.warn('plan_execution_accept_failed', { executionId, change: row.change, error: String(error) }))
    }
  }
  // Cleanup: remove the worktree only when clean and unoccupied (D13 step 6).
  if (row.worktree !== null && fs.existsSync(row.worktree)) {
    const dirty = runGit(['status', '--porcelain'], { cwd: row.worktree })
    const occupied = [...deps.records()].some(record =>
      record.archivedAt == null && (record.projectPath === row.worktree || record.projectPath.startsWith(`${row.worktree}${path.sep}`)))
    if (dirty.ok && dirty.stdout.trim() === '' && !occupied) {
      store.insertEffect({
        executionId, change: row.change, roundId: null, kind: 'remove-worktree',
        effectKey: `${executionId}:${row.change}:remove-worktree:${deps.now()}`,
        command: { repo: deps.team.groupsRoot, path: row.worktree },
      })
    }
  }
  // Completion: when every change has landed, the execution completes and
  // the plan completes as the system (D19). A stopped execution settling
  // its one running merge (D12) stays stopped.
  const changes = store.changes(executionId)
  if (execution.state === 'running' && changes.length > 0 && changes.every(entry => entry.state === 'landed')) {
    store.finishExecution(executionId, 'completed')
    const completed = deps.plansService.completeBySystem(execution.planId, executionId)
    if (!completed.ok) logger.info('plan_execution_plan_left_open', { executionId, reason: completed.reason, message: completed.message })
  }
}
