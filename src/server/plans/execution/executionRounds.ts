// The round pipeline (plan-execution D9-D11, §12): a newer result becomes
// the change's round (superseding the open one, unless its merge started),
// the round's commit is pushed and given the change's one pull request, CI
// is read and evaluated with the one rerun, a passing round releases the
// worktree's spawned implementer and dispatches the review handoff, and the
// verdict — only an independent claimant's, never an author's — decides the
// round. Effects are recorded before they run (D14); the CI read runs in
// the tick (one read per gating round per minute, driven by the timer).
import path from 'node:path'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ChatSessionRecord } from '../../db'
import type { TaskService } from '../../team/TaskService'
import type { TaskResultService } from '../../team/TaskResultService'
import { evaluateCi, reviewVerdict, splitExtraChecks } from '../../../shared/planExecutionGates'
import type { CiCheck, StopDetail, StopReason } from '../../../shared/planExecution'
import type { PlanCheck } from '../../../shared/plans'
import type { RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { lsRemoteHead, pushToRemote } from '../landing/gitRemote'
import { ghCheckRuns, ghPrCreate, ghPrList, ghRerunFailed, ghStatuses } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { AssignmentService } from '../../team/AssignmentService'
import { dispatchFixAttempt } from './executionDispatch'
import type { EffectAdapter } from './effects'

/** The gh/git surface the pipeline uses; injectable for tests. */
export interface RoundAdapters {
  lsRemoteHead: typeof lsRemoteHead
  push: typeof pushToRemote
  checkRuns: typeof ghCheckRuns
  statuses: typeof ghStatuses
  prList: typeof ghPrList
  prCreate: typeof ghPrCreate
  rerun: typeof ghRerunFailed
}

export const roundAdapters: RoundAdapters = {
  lsRemoteHead, push: pushToRemote, checkRuns: ghCheckRuns, statuses: ghStatuses,
  prList: ghPrList, prCreate: ghPrCreate, rerun: ghRerunFailed,
}

export interface RoundDeps {
  team: TeamIdentity
  /** origin as owner/repo (the probe's read); every gh call is addressed to it. */
  repo: string
  executions: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  results: TaskResultService
  assignments: AssignmentService
  adapters: RoundAdapters
  /** Passed to every gh call (tests stub gh on a private PATH). */
  ghOptions?: GhCommandOptions
  /**
   * D11's release step: readiness and the archive+journal release of one
   * spawned member. The composition wires member-release; without it the
   * step is skipped (the implementer stays, as an unscoped group's would).
   */
  releases?: {
    readiness: (sessionId: string) => { ready: boolean; reason: string | null }
    release: (sessionId: string) => void
  }
  /** The group files: whether the review group is worktree-scoped (default true). */
  groupScoped?: (teamId: string, groupId: string) => boolean
  records?: () => Iterable<ChatSessionRecord>
  now: () => string
}

/** One stage performance; throws nothing — a failed git/gh read leaves the stage due again. */
export async function applyRoundStage(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null; taskId: string | null }, stage: { kind: string; roundId: string | null; resultId: string | null }): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)
  if (execution === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change) ?? null

  if (stage.kind === 'result' && stage.resultId !== null) {
    const attempt = store.attempts(changeRow.executionId, changeRow.change).at(-1)
    if (attempt === undefined) return
    const commit = deps.tasks.store.results.get(stage.resultId)?.commit
    if (commit === null || commit === undefined) return
    store.insertRound({
      executionId: changeRow.executionId, change: changeRow.change,
      attemptId: attempt.id, resultId: stage.resultId, commitSha: commit,
      fixRound: attempt.kind !== 'implement',
    })
    return
  }

  const round = stage.roundId === null ? null : store.round(stage.roundId)
  if (round === null) return

  // Push and open-pr are effect rows (D14): the runner calls them, and the
  // done handler records what they imply. The stage only inserts the row.
  if (stage.kind === 'push') {
    const change = store.change(changeRow.executionId, changeRow.change)
    if (change === null) return
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'push',
      effectKey: `${changeRow.executionId}:${changeRow.change}:push:${round.number}:${change.generation}`,
      command: { cwd: changeRow.worktree ?? deps.team.groupsRoot, commit: round.commitSha, branch: changeRow.branch ?? changeRow.change },
    })
    return
  }

  if (stage.kind === 'open-pr') {
    if (changeRow.branch === null) return
    const change = store.change(changeRow.executionId, changeRow.change)
    if (change === null) return
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'open-pr',
      effectKey: `${changeRow.executionId}:${changeRow.change}:open-pr:${round.number}:${change.generation}`,
      command: { repo: deps.repo, head: changeRow.branch, base: execution.baseBranch, title: `${changeRow.change} — ${deps.plans.get(execution.planId)?.title ?? execution.planId} (r${execution.revision})` },
    })
    return
  }

  if (stage.kind === 'ci') return pollCi(deps, changeRow, round, entry?.extraChecks ?? [])
  if (stage.kind === 'review') return dispatchReview(deps, changeRow, round)
  if (stage.kind === 'verdict') return decideVerdict(deps, changeRow, round, entry?.extraChecks ?? [])
  if (stage.kind === 'revision') {
    // D9: supersede the pinned round and dispatch a fix attempt naming the
    // revision. The change goes back to implementing; the slot, if the
    // change somehow held it, releases by leaving `landing` — a landing
    // change never reaches this stage.
    const task = changeRow.taskId === null ? null : deps.tasks.store.get(changeRow.taskId)
    if (task === null || task === undefined) return
    const change = store.change(changeRow.executionId, changeRow.change)
    if (change === null) return
    store.supersedeRound(round.id)
    store.transition(changeRow.executionId, changeRow.change, change, { state: 'implementing', step: null })
    const group = entry?.group
    if (group === null || group === undefined) return
    const revisionRow = deps.tasks.store.revisions(task.id).at(-1)
    await dispatchFixAttempt(
      { team: deps.team, executions: store, plans: deps.plans, tasks: deps.tasks, assignments: deps.assignments, results: deps.results },
      {
        executionId: changeRow.executionId, change: changeRow.change, group,
        failingChecks: [],
        findingsIds: [],
        findingsTexts: [`The task's direction was republished as revision ${task.revision}${revisionRow?.rationale ? ` (${revisionRow.rationale})` : ''}. Re-apply your work on top of the new direction.`],
        continueFrom: round.commitSha,
        fixRounds: change.fixRounds,
      },
    )
    return
  }
}

async function pollCi(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow, extra: PlanCheck[]): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)!
  const repo = deps.repo
  const runs = await deps.adapters.checkRuns(repo, round.commitSha, deps.ghOptions)
  const statuses = await deps.adapters.statuses(repo, round.commitSha, deps.ghOptions)
  if (!runs.ok || !statuses.ok) return
  const checks: CiCheck[] = [...runs.data, ...statuses.data]
  const change = store.change(changeRow.executionId, changeRow.change)
  const rerunEffect = change === null ? null : store.effectByKey(`${changeRow.executionId}:${changeRow.change}:rerun:${round.number}:${change.generation}`)
  const rerunOutcome = rerunEffect !== null && rerunEffect.state === 'done' && rerunEffect.outcome !== null && typeof rerunEffect.outcome === 'object'
    ? rerunEffect.outcome as { at?: string; runIds?: number[] } : null
  const evaluation = evaluateCi(checks, execution.floor.map, {
    windowFrom: round.ciWindowFrom ?? round.pushedAt ?? deps.now(), now: deps.now(),
    rerun: rerunOutcome?.at && Array.isArray(rerunOutcome.runIds) ? { at: rerunOutcome.at, runIds: rerunOutcome.runIds } : null,
  })
  store.setRoundCi(round.id, checks, rerunOutcome?.at ?? null)
  if (evaluation.kind === 'pending') return
  if (evaluation.kind === 'pass') {
    // The review stage follows in the same tick: release, then handoff (D11).
    return dispatchReview(deps, changeRow, store.round(round.id)!)
  }
  if (evaluation.kind === 'fail') {
    store.decideRound(round.id, 'fail')
    return
  }
  if (evaluation.kind === 'rerun') {
    // The round's one rerun: an effect row, retried and inspected like any (D14).
    const change = store.change(changeRow.executionId, changeRow.change)!
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'rerun',
      effectKey: `${changeRow.executionId}:${changeRow.change}:rerun:${round.number}:${change.generation}`,
      command: { repo: deps.repo, runIds: evaluation.runIds },
    })
    return
  }
  return stopChange(deps, changeRow, evaluation.reason, evaluation.detail)
}

async function dispatchReview(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)!
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change) ?? null
  const reviewGroup = entry?.reviewGroup ?? revision?.content.reviewGroup ?? null
  if (reviewGroup === null) return
  const change = store.change(changeRow.executionId, changeRow.change)!
  // D11 step 1 — Release: a worktree-scoped review group gets the worktree,
  // so each live spawned member in it is released once ready; a not-ready
  // member holds the step at `releasing`, re-checked on the next wake.
  // Human-created sessions never release. An unscoped group (or no wiring)
  // skips the step and leaves the implementer working.
  if (deps.releases !== undefined && change.worktree !== null
    && (deps.groupScoped?.(deps.team.teamId, reviewGroup) ?? true)) {
    const members = [...(deps.records?.() ?? [])].filter(record =>
      record.archivedAt == null && record.spawned === true
      && (record.projectPath === change.worktree || record.projectPath.startsWith(`${change.worktree}${path.sep}`))
      && record.groupId !== reviewGroup)
    for (const member of members) {
      const readiness = deps.releases.readiness(member.sessionId)
      if (!readiness.ready) {
        if (change.step !== 'releasing') store.transition(changeRow.executionId, changeRow.change, change, { step: 'releasing' })
        return
      }
      deps.releases.release(member.sessionId)
    }
  }
  if (change.step !== 'reviewing') store.transition(changeRow.executionId, changeRow.change, change, { step: 'reviewing' })
  const role = revision?.content.roles.find(candidate => candidate.group === reviewGroup)?.profiles ?? []
  const authors = (change.taskId ? deps.tasks.store.results.listByTask(change.taskId) : [])
    .map(result => result.submittedBy.sessionId).filter((id): id is string => id !== null)
  const outcome = await deps.results.handoff({ kind: 'system', team: deps.team, executionId: changeRow.executionId }, change.taskId!, {
    kind: 'review', resultId: round.resultId, target: { kind: 'group', id: reviewGroup },
    instructions: reviewInstruction(deps, changeRow.change, round, entry?.extraChecks ?? []),
    requestKey: `exec:${changeRow.executionId}:${changeRow.change}:round:${round.number}:review`,
    ...(role.length > 0 ? { allowedProfiles: role } : {}),
    tags: [...new Set(authors.flatMap(session => sessionProfileOf(deps, session)).map(profile => `author-profile:${profile}`))],
  })
  if ('assignment' in outcome) store.setRoundReview(round.id, outcome.assignment.id)
}

function sessionProfileOf(deps: RoundDeps, sessionId: string): string[] {
  const record = [...(deps.records?.() ?? [])].find(row => row.sessionId === sessionId)
  return record?.claudeProfileId ? [record.claudeProfileId] : []
}

async function decideVerdict(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow, extra: PlanCheck[]): Promise<void> {
  const store = deps.executions
  const change = store.change(changeRow.executionId, changeRow.change)
  if (change === null || change.taskId === null) return
  const assignment = deps.tasks.store.assignmentsOf(change.taskId).find(row => row.id === round.reviewAssignmentId)
  const claimants = assignment?.claimedBy ? [assignment.claimedBy] : []
  const authors = deps.tasks.store.results.listByTask(change.taskId)
    .map(result => result.submittedBy.sessionId).filter((id): id is string => id !== null)
  const findings = deps.tasks.store.results.findingsFor(round.resultId)
    .map(row => ({ id: row.id, resultId: row.resultId, handoffId: row.handoffId, author: row.author.kind === 'agent' ? row.author.sessionId! : '', verdict: row.verdict, createdAt: row.createdAt }))
  const verdict = reviewVerdict(round, findings, claimants, authors)
  if (verdict.kind === 'pending') return
  if (verdict.kind === 'author-claimant') {
    return stopChange(deps, changeRow, 'review-unavailable', { message: `Session ${verdict.session} claimed the review of its own work.`, session: verdict.session })
  }
  const counted = verdict.kind === 'pass' ? verdict.findingsId : verdict.kind === 'fail' ? verdict.findingsId : null
  if (verdict.kind === 'fail') {
    store.decideRound(round.id, 'fail', { verdictFindingsId: counted ?? undefined })
    return
  }
  // Pass: the extra checks CI decides must be green; the attested ones ride
  // the verdict (D11).
  const reported = new Set((round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'success').map(check => check.name))
  const split = splitExtraChecks(extra, [...reported])
  const extraView = [
    ...split.ci.map(check => ({ name: check.name, description: check.description, command: check.command ?? null, by: 'ci' as const, outcome: 'success' })),
    ...split.attested.map(check => ({ name: check.name, description: check.description, command: check.command ?? null, by: 'reviewer' as const, outcome: 'attested' })),
  ]
  store.decideRound(round.id, 'pass', { verdictFindingsId: counted ?? undefined, extra: extraView })
  const fresh = store.change(changeRow.executionId, changeRow.change)!
  store.transition(changeRow.executionId, changeRow.change, fresh, { passedAt: deps.now(), step: null })
}

/** Record the change's pull request (the open-pr effect's done handler). */
export function recordPull(executions: ExecutionStore, executionId: string, change: string, pr: { number: number; url: string; openedByKawai: boolean }): void {
  const row = executions.change(executionId, change)
  if (row === null) return
  // An unchanged PR writes nothing: the transition would bump the change's
  // generation and churn every effect key (D14).
  if (row.prNumber === pr.number && row.prUrl === pr.url && row.prOpenedByKawai === pr.openedByKawai) return
  executions.transition(executionId, change, row, { prNumber: pr.number, prUrl: pr.url, prOpenedByKawai: pr.openedByKawai })
}

async function stopChange(deps: RoundDeps, changeRow: { executionId: string; change: string }, reason: StopReason, detail: StopDetail): Promise<void> {
  const change = deps.executions.change(changeRow.executionId, changeRow.change)
  if (change === null) return
  deps.executions.transition(changeRow.executionId, changeRow.change, change, { state: 'stopped', stopReason: reason as StopReason, stopDetail: detail, step: null })
}

function reviewInstruction(deps: RoundDeps, change: string, round: RoundRow, extra: PlanCheck[]): string {
  const execution = deps.executions.execution(round.executionId)!
  const changeRow = deps.executions.change(round.executionId, change)!
  const checks = (round.ci ?? []).map(check => `${check.name}: ${check.conclusion}`).join(', ')
  const extraLines = extra.map(check => `- ${check.name}: ${check.description}${check.command ? ` (command: ${check.command})` : ''}`).join('\n')
  return [
    `Review the result ${round.resultId} of change "${change}" (round ${round.number}, commit ${round.commitSha}).`,
    changeRow.prUrl ? `Pull request: ${changeRow.prUrl}` : null,
    `CI: ${checks || 'none reported'}`,
    extraLines !== '' ? `Extra checks to attest:\n${extraLines}` : null,
    `Submit your verdict with task_submit_findings on task ${changeRow.taskId} for result ${round.resultId}: pass or fail, with what you checked.`,
    'You are the independent reviewer: if you authored one of this change\'s results, do not review it — say so in a message to the Lead group instead.',
  ].filter(line => line !== null).join('\n\n') + `\n\nExecution ${execution.id} of plan ${execution.planId} at revision ${execution.revision}.`
}

// --- The round effects' adapters (D14): the runner calls them ---

/** The push effect: the implementer's own push counts; a moved branch never forces (plan-landing). */
export function pushAdapter(adapters: Pick<RoundAdapters, 'lsRemoteHead' | 'push'>): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const cwd = String(command.cwd ?? '')
      const commit = String(command.commit ?? '')
      const branch = String(command.branch ?? '')
      const head = await adapters.lsRemoteHead(cwd, `refs/heads/${branch}`)
      if (head.ok && head.sha === commit) return { ok: true, outcome: { head, pushedByKawai: false } }
      const pushed = await adapters.push(cwd, commit, branch)
      if (!pushed.ok) return { ok: false, error: pushed.error }
      return { ok: true, outcome: { head: commit, pushedByKawai: true } }
    },
  }
}

/** The open-pr effect: reuse the open pull request, create the change's one, stop on a closed one. */
export function openPrAdapter(adapters: Pick<RoundAdapters, 'prList' | 'prCreate'>, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const head = String(command.head ?? '')
      const base = String(command.base ?? '')
      const pulls = await adapters.prList(repo, { head, base }, ghOptions)
      if (!pulls.ok) return { ok: false, error: pulls.error }
      const open = pulls.data.find(pull => pull.state === 'OPEN')
      if (open) return { ok: true, outcome: { number: open.number, url: open.url, openedByKawai: false } }
      const closed = pulls.data.find(pull => pull.state === 'CLOSED')
      if (closed) {
        return { ok: false, error: { argv: ['gh', 'pr', 'list'], exitCode: 1, httpStatus: null, message: `Pull request ${closed.number} was closed without merging (pr-closed).` } }
      }
      const created = await adapters.prCreate(repo, { head, base, title: String(command.title ?? head), body: String(command.body ?? '') }, ghOptions)
      if (!created.ok) return { ok: false, error: created.error }
      return { ok: true, outcome: { number: created.data.number, url: created.data.url, openedByKawai: true } }
    },
  }
}

/** The rerun effect: the round's one rerun of failed Actions runs (D10). */
export function rerunAdapter(adapters: Pick<RoundAdapters, 'rerun'>, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const runIds = Array.isArray(command.runIds) ? command.runIds.filter((id): id is number => typeof id === 'number') : []
      for (const runId of runIds) {
        const rerun = await adapters.rerun(repo, runId, ghOptions)
        if (!rerun.ok) return { ok: false, error: rerun.error }
      }
      return { ok: true, outcome: { at: new Date().toISOString(), runIds } }
    },
  }
}
