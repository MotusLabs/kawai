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
import type { EffectRow, RoundRow } from './executionRows'
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
export async function applyLanding(deps: LandingDeps, adapters: LandingAdapters, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null; prNumber: number | null; state: string; step: string | null; taskId: string | null }, round: RoundRow): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)
  if (execution === null || changeRow.branch === null) return

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
    } catch {
      return // slot-taken: wait
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
  if (!base.ok || base.sha === null) return
  const contains = await adapters.isAncestor(changeRow.worktree ?? deps.team.groupsRoot, base.sha, head.sha)
  if (!contains.ok) return
  if (!contains.ancestor) {
    // The base moved into the branch's future: predict the merge.
    const prediction = await adapters.mergeTree(changeRow.worktree ?? deps.team.groupsRoot, head.sha, base.sha)
    if (!prediction.ok) return
    if (prediction.conflicts.length > 0) {
      // A conflict releases the slot (leaving `landing`) and dispatches an
      // update attempt naming the files.
      const fresh = store.change(changeRow.executionId, changeRow.change)!
      store.transition(changeRow.executionId, changeRow.change, fresh, { state: 'gating', step: null, stopReason: null, stopDetail: null })
      return dispatchUpdateAttempt(deps, changeRow, round, { kind: 'conflict', files: prediction.conflicts, base: base.sha })
    }
    // Clean: the update-branch effect runs, pinned to the reviewed head.
    const fresh = store.change(changeRow.executionId, changeRow.change)!
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'update-branch',
      effectKey: `${changeRow.executionId}:${changeRow.change}:update-branch:${round.number}:${fresh.generation}`,
      command: { repo: deps.repo, pr: changeRow.prNumber ?? 0, head: head.sha },
    })
    store.transition(changeRow.executionId, changeRow.change, fresh, { step: 'updating' })
    return
  }

  // Step 4 — Merge: pinned to the reviewed head (or the carried head).
  const fresh = store.change(changeRow.executionId, changeRow.change)!
  if (fresh === null || fresh.step === 'merging') return
  store.transition(changeRow.executionId, changeRow.change, fresh, { step: 'merging' })
  store.insertEffect({
    executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'merge',
    effectKey: `${changeRow.executionId}:${changeRow.change}:merge:${round.number}:${fresh.generation}`,
    command: { repo: deps.repo, pr: changeRow.prNumber ?? 0, head: head.sha, base: base.sha, baseBranch: execution.baseBranch, method: execution.mergeMethod, cwd: changeRow.worktree ?? deps.team.groupsRoot },
  })
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
  await refusable('update', () => deps.results.handoff({ kind: 'system', team: deps.team, executionId: changeRow.executionId }, taskId, {
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
      const base = await adapters.lsRemoteHead(cwd, `refs/heads/${String(command.baseBranch ?? 'master')}`)
      if (!base.ok) return { ok: false, error: { argv: ['git', 'ls-remote'], exitCode: 1, stderr: 'the base could not be read' } }
      const contains = await adapters.isAncestor(cwd, base.sha!, head)
      if (!contains.ok || !contains.ancestor) {
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
  const outcome = effect.outcome as { merged?: boolean; baseMoved?: boolean; base?: string; mergeCommit?: string; head?: string; requested?: boolean } | null
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
    if (view.data.headRefOid === reviewedHead) {
      return // not moved yet
    }
    // The clean-merge check: parents [H, B'], the base contains B', and the
    // tree equals merge-tree H B'.
    const base = await adapters.lsRemoteHead(row.worktree ?? deps.team.groupsRoot, `refs/heads/${execution.baseBranch}`)
    if (!base.ok || base.sha === null) return
    const parents = await runGit(['log', '-1', '--pretty=%P', view.data.headRefOid], { cwd: row.worktree ?? deps.team.groupsRoot })
    const parentList = parents.ok ? parents.stdout.trim().split(/\s+/) : []
    const predicted = await adapters.mergeTree(row.worktree ?? deps.team.groupsRoot, reviewedHead, base.sha)
    const secondParent = parentList.find(parent => parent !== reviewedHead) ?? ''
    const secondAncestry = secondParent === '' ? null : await adapters.isAncestor(row.worktree ?? deps.team.groupsRoot, secondParent, base.sha)
    const secondContained = secondAncestry !== null && secondAncestry.ok && secondAncestry.ancestor
    const clean = parents.ok && predicted.ok
      && parentList.length === 2
      && parentList.includes(reviewedHead)
      && secondContained
      && (await runGit(['rev-parse', `${view.data.headRefOid}^{tree}`], { cwd: row.worktree ?? deps.team.groupsRoot })).stdout.trim() === predicted.tree
    if (clean) {
      // The carried round: CI runs on the new head (D13).
      const round = effect.roundId !== null && effect.roundId !== undefined ? store.round(effect.roundId) : null
      if (round !== null) {
        store.insertCarriedRound({
          executionId: effect.executionId, change: effect.change, attemptId: round.attemptId,
          resultId: round.resultId, commitSha: view.data.headRefOid, carriedFrom: round.id, ciWindowFrom: deps.now(),
        })
        store.transition(effect.executionId, effect.change, fresh, { step: 'up-to-date', passedAt: null })
      }
      return
    }
    store.transition(effect.executionId, effect.change, fresh, { state: 'gating', step: null })
    const carried = store.rounds(effect.executionId, effect.change).at(-1)!
    await dispatchUpdateAttempt(deps, { executionId: effect.executionId, change: effect.change, taskId: fresh.taskId }, carried, { kind: 'failed-check' })
    return
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
    runGit(['fetch', '--quiet', 'origin', execution.baseBranch], { cwd: row.worktree ?? deps.team.groupsRoot })
    const mergeTree_ = await runGit(['rev-parse', `${mergeCommit}^{tree}`], { cwd: row.worktree ?? deps.team.groupsRoot })
    const headTree = await runGit(['rev-parse', `${head}^{tree}`], { cwd: row.worktree ?? deps.team.groupsRoot })
    const treeVerified = mergeTree_.ok && headTree.ok && mergeTree_.stdout.trim() === headTree.stdout.trim()
    store.insertLanding({
      planId: execution.planId, change: effect.change, executionId: effect.executionId, teamId: execution.teamId,
      mechanism: 'direct', prNumber: row.prNumber, prUrl: row.prUrl,
      headSha: head, baseSha: String(outcome.base ?? ''), mergeSha: mergeCommit, treeVerified,
    })
    store.transition(effect.executionId, effect.change, row, { state: 'landed', step: null })
    // Kawai accepts the landed change's result (idempotent per result).
    if (row.taskId !== null) {
      const round = store.rounds(effect.executionId, effect.change).find(entry => entry.commitSha === head) ?? null
      if (round !== null) {
        // The change is landed whatever the acceptance says; a refused
        // acceptance is logged and the task stays for the human to close.
        await deps.results.accept({ kind: 'system', team: deps.team, executionId: effect.executionId }, row.taskId, round.resultId)
          .catch(error => logger.warn('plan_execution_accept_failed', { executionId: effect.executionId, change: effect.change, error: String(error) }))
      }
    }
    // Cleanup: remove the worktree only when clean and unoccupied (D13 step 6).
    if (row.worktree !== null && fs.existsSync(row.worktree)) {
      const dirty = runGit(['status', '--porcelain'], { cwd: row.worktree })
      const occupied = [...deps.records()].some(record =>
        record.archivedAt == null && (record.projectPath === row.worktree || record.projectPath.startsWith(`${row.worktree}${path.sep}`)))
      if (dirty.ok && dirty.stdout.trim() === '' && !occupied) {
        store.insertEffect({
          executionId: effect.executionId, change: effect.change, roundId: null, kind: 'remove-worktree',
          effectKey: `${effect.executionId}:${effect.change}:remove-worktree:${deps.now()}`,
          command: { repo: deps.team.groupsRoot, path: row.worktree },
        })
      }
    }
    // Completion: when every change has landed, the execution completes and
    // the plan completes as the system (D19). A stopped execution settling
    // its one running merge (D12) stays stopped.
    const changes = store.changes(effect.executionId)
    if (execution.state === 'running' && changes.length > 0 && changes.every(entry => entry.state === 'landed')) {
      store.finishExecution(effect.executionId, 'completed')
      const completed = deps.plansService.completeBySystem(execution.planId, effect.executionId)
      if (!completed.ok) logger.info('plan_execution_plan_left_open', { executionId: effect.executionId, reason: completed.reason, message: completed.message })
    }
  }
}
