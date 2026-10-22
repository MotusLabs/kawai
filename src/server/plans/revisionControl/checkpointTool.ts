// The `task_checkpoint` tool (revision-control D7): a Pausing holder records
// where its work stands, and Kawai pushes the commit to the change's branch —
// plan-execution D18 tells agents never to push, and every outbound write is
// an audited effect, so the agent commits and the `push-checkpoint` effect
// pushes, never forced. The refusals each carry their fix; the success is one
// transaction: the checkpoint (superseding the target's earlier one), the
// effect, and the target's pointer. A round's submitted result counts too:
// once its push is done, Kawai records the `result` checkpoint itself.
import { isAncestor, lsRemoteHead } from '../landing/gitRemote'
import { runGit } from '../../git/gitCommand'
import { z } from 'zod'
import type { ExecutionStore } from '../execution/executionStore'
import type { ChangeRow } from '../execution/executionRows'
import type { PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { CheckpointStore, NewPlanCheckpoint } from './checkpointStore'
import type { PauseStore } from './pauseStore'

export type CheckpointRefusal =
  | 'no-execution'
  | 'no-pause-requested'
  | 'commit-required'
  | 'not-branch-head'
  | 'dirty-worktree'
  | 'not-contains-origin'
  | 'kawai-writing'

export type CheckpointOutcome =
  | { ok: true; checkpointId: string; effectId: string | null }
  | { ok: false; reason: CheckpointRefusal; message: string }

/** The read that names a result's submitter, so a `result` checkpoint can carry it. */
export type ResultOf = (resultId: string) => { sessionId: string | null } | null

export interface CheckpointToolDeps {
  executions: ExecutionStore
  pauses: PauseStore
  checkpoints: CheckpointStore
  /** The submitted results (the `result` kind's submitter session); absent in stores-only benches. */
  resultOf?: ResultOf
  now?: () => Date
}

export interface CheckpointInput {
  task_id: string
  commit?: string
  summary: string
  unfinished?: string
  errors_tests?: string
  next_steps: string
}

const refuse = (reason: CheckpointRefusal, message: string): CheckpointOutcome => ({ ok: false, reason, message })

/** The change's worktree and branch, or the refusal for their absence. */
function worktreeOf(row: ChangeRow): { cwd: string; branch: string } | CheckpointOutcome {
  if (row.worktree === null || row.branch === null) {
    return refuse('no-execution', `The change ${row.change} has no worktree or branch yet; keep working and submit with task_submit_result.`)
  }
  return { cwd: row.worktree, branch: row.branch }
}

export class CheckpointTool {
  constructor(private readonly deps: CheckpointToolDeps) {}

  /**
   * The target of the caller's task: the change a running execution owns.
   * Anything else — no change, a stopped execution — reads as no execution
   * (D7's first refusal, with the keep-working fix).
   */
  private targetOf(taskId: string): { executionId: string; planId: string; teamId: string; row: ChangeRow } | CheckpointOutcome {
    const row = this.deps.executions.ownerOfTask(taskId)
    if (row === null) return refuse('no-execution', 'The task is not owned by a running execution; keep working and submit with task_submit_result.')
    const execution = this.deps.executions.execution(row.executionId)
    if (execution === null || execution.state !== 'running') {
      return refuse('no-execution', 'The task is not owned by a running execution; keep working and submit with task_submit_result.')
    }
    return { executionId: execution.id, planId: execution.planId, teamId: row.teamId, row }
  }

  /**
   * Every open pause target of the change that names the caller: unwithdrawn,
   * undecided, across every open pause of the plan — never only the plan's
   * first pause, whose targets may not hold this change (D6 allows pauses on
   * different holds to stand side by side, and two holds can cover one change).
   */
  private pausingTargets(teamId: string, planId: string, change: string, sessionId: string): Array<{ pauseId: string; target: PlanPauseTarget }> {
    const found: Array<{ pauseId: string; target: PlanPauseTarget }> = []
    for (const pause of this.deps.pauses.forPlan(teamId, planId, true)) {
      const target = this.deps.pauses.target(pause.id, change)
      if (target !== null && !target.withdrawn && target.decision === null && target.holderSession === sessionId) {
        found.push({ pauseId: pause.id, target })
      }
    }
    return found
  }

  /** The commit checks (D7): the branch's head, a clean worktree, and origin's head contained. */
  private async checkCommit(cwd: string, branch: string, commit: string): Promise<CheckpointOutcome | null> {
    const head = runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd })
    if (!head.ok || head.stdout.trim() !== commit) {
      const actual = head.ok ? head.stdout.trim() : `unreadable (${head.stderr.trim()})`
      return refuse('not-branch-head', `The commit is not the head of refs/heads/${branch} (originally ${actual}); commit on ${branch} and record again.`)
    }
    const status = runGit(['status', '--porcelain'], { cwd })
    if (!status.ok) {
      return refuse('dirty-worktree', `Reading the worktree state failed: ${status.stderr.trim()}. Record again once git reads it.`)
    }
    if (status.stdout.trim() !== '') {
      const paths = status.stdout.trim().split('\n').map(line => line.slice(3).trim()).join(', ')
      return refuse('dirty-worktree', `The worktree is not clean: ${paths}. Commit (or stash) these first; ignored files are excluded.`)
    }
    const origin = await lsRemoteHead(cwd, `refs/heads/${branch}`)
    // A branch origin has never seen carries no head to contain.
    if (!origin.ok) return refuse('not-contains-origin', `Reading origin's ${branch} failed: ${origin.error.stderr.trim()}. Record again once it reads.`)
    if (origin.sha !== null) {
      const contains = await isAncestor(cwd, origin.sha, commit)
      if (!contains.ok) return refuse('not-contains-origin', `Reading origin's ${branch} failed: ${contains.error.stderr.trim()}. Record again once it reads.`)
      if (!contains.ancestor) {
        return refuse('not-contains-origin', `The commit does not contain origin's ${branch} head ${origin.sha}; rebase or merge it and record again.`)
      }
    }
    return null
  }

  /**
   * One `task_checkpoint` call (D7): every refusal before any write; the
   * success is one transaction — the checkpoint (superseding the target's
   * earlier one), the `push-checkpoint` effect for a commit, and the
   * target's pointer. The checkpoint id is the effect's round slot (D7's
   * key), so each recorded checkpoint pushes under its own key.
   */
  async record(caller: { kind: 'agent'; sessionId: string }, input: CheckpointInput): Promise<CheckpointOutcome> {
    const found = this.targetOf(input.task_id)
    if (!('row' in found)) return found
    const { row } = found
    const pausing = this.pausingTargets(found.teamId, found.planId, row.change, caller.sessionId)
    if (pausing.length === 0) {
      return refuse('no-pause-requested', `No pause of ${row.change} names this session as its claimant; keep working and submit with task_submit_result, or wait for the pause mail.`)
    }
    if (row.state === 'landing' && (row.step === 'updating' || row.step === 'merging')) {
      return refuse('kawai-writing', `Kawai is writing the branch (landing ${row.step}); record again once that step ends.`)
    }
    const commit = input.commit ?? null
    if (commit === null) {
      if (pausing[0].target.stage === 'attempt') {
        return refuse('commit-required', 'An attempt target records a commit; pass the commit your work stands on.')
      }
      // A review target without a commit leaves notes (D7): no effect, the write alone.
      return this.insert(found, pausing, caller.sessionId, input, null)
    }
    const place = worktreeOf(row)
    if (!('cwd' in place)) return place
    const checked = await this.checkCommit(place.cwd, place.branch, commit)
    if (checked !== null) return checked
    return this.insert(found, pausing, caller.sessionId, input, commit, place)
  }

  /**
   * The shared write: one transaction inserting the checkpoint per served
   * target (each pause's own chain, so supersede stays per target), the
   * target pointers, and — for a commit — one `push-checkpoint` effect under
   * the first row's key, so one recording pushes once.
   */
  private insert(
    found: { executionId: string; row: ChangeRow },
    pausing: Array<{ pauseId: string; target: PlanPauseTarget }>,
    sessionId: string,
    input: CheckpointInput,
    commit: string | null,
    place?: { cwd: string; branch: string },
  ): CheckpointOutcome {
    const attempt = this.deps.executions.attempts(found.executionId, found.row.change).at(-1) ?? null
    const fresh = this.deps.executions.change(found.executionId, found.row.change) ?? found.row
    let checkpointId: string | null = null
    let effectId: string | null = null
    this.deps.pauses.db.transaction(() => {
      for (const { pauseId } of pausing) {
        const record: NewPlanCheckpoint = {
          executionId: found.executionId,
          change: found.row.change,
          pauseId,
          attemptId: attempt?.id ?? null,
          sessionId,
          kind: commit === null ? 'notes' : 'commit',
          commitSha: commit,
          baselineCommit: attempt?.manifest.baseline ?? fresh.baselineCommit,
          manifestHash: attempt?.manifestHash ?? null,
          resultId: null,
          summary: input.summary,
          unfinished: input.unfinished ?? null,
          errorsTests: input.errors_tests ?? null,
          nextSteps: input.next_steps,
          effectId: null,
        }
        const checkpoint = this.deps.checkpoints.insert(record)
        if (commit !== null && place !== undefined && effectId === null) {
          const effect = this.deps.executions.insertEffect({
            executionId: found.executionId, change: found.row.change, roundId: checkpoint.id,
            kind: 'push-checkpoint',
            effectKey: `${found.executionId}:${found.row.change}:push-checkpoint:${checkpoint.id}:${fresh.generation}`,
            command: { cwd: place.cwd, commit, branch: place.branch },
          })
          this.deps.checkpoints.setEffect(checkpoint.id, effect.id)
          effectId = effect.id
        }
        this.deps.pauses.setCheckpoint(pauseId, found.row.change, checkpoint.id)
        // The primary id is the effect's round slot: the first served target.
        if (checkpointId === null) checkpointId = checkpoint.id
      }
    })()
    return { ok: true, checkpointId: checkpointId!, effectId }
  }

  /**
   * A result counts (D7): once the round's push is done and its change is
   * Pausing with no checkpoint recorded, Kawai records the `result`
   * checkpoint itself — the holder never calls the tool for it. It counts
   * for every open, uncheckpointed target of the change across every open
   * pause of the plan; the holder's own record always wins: a target with a
   * checkpoint is skipped.
   */
  recordResultCheckpoint(executionId: string, change: string, roundId: string): void {
    const round = this.deps.executions.round(roundId)
    if (round === null || round.change !== change) return
    const execution = this.deps.executions.execution(executionId)
    if (execution === null || execution.state !== 'running') return
    const attempt = this.deps.executions.attempts(executionId, change).find(entry => entry.id === round.attemptId) ?? null
    const result = this.deps.resultOf?.(round.resultId) ?? null
    for (const pause of this.deps.pauses.forPlan(execution.teamId, execution.planId, true)) {
      const target = this.deps.pauses.target(pause.id, change)
      if (target === null || target.withdrawn || target.decision !== null || target.checkpointId !== null) continue
      const checkpoint = this.deps.checkpoints.insert({
        executionId, change, pauseId: pause.id, attemptId: round.attemptId,
        sessionId: result?.sessionId ?? target.holderSession ?? 'kawai',
        kind: 'result', commitSha: round.commitSha,
        baselineCommit: attempt?.manifest.baseline ?? null, manifestHash: attempt?.manifestHash ?? null,
        resultId: round.resultId,
        summary: `Kawai recorded this checkpoint from the round's submitted result (${round.resultId}).`,
        unfinished: null, errorsTests: null, nextSteps: '', effectId: null,
      })
      this.deps.pauses.setCheckpoint(pause.id, change, checkpoint.id)
    }
  }
}



export const CHECKPOINT_TOOL_NAMES = ['task_checkpoint'] as const

export const checkpointSchemas = {
  task_checkpoint: z.object({
    task_id: z.string().min(1),
    commit: z.string().min(1).optional(),
    summary: z.string().min(1),
    unfinished: z.string().optional(),
    errors_tests: z.string().optional(),
    next_steps: z.string().min(1),
  }),
}

export const checkpointDescriptions: Record<(typeof CHECKPOINT_TOOL_NAMES)[number], string> = {
  task_checkpoint: 'Record where your work stands while Kawai paused your change (revision-control): commit (the commit your work stands on, the branch head), summary, unfinished, errors_tests, next_steps. Kawai pushes the commit to the change branch itself — never push it. A review target may omit commit to leave notes. Outside a pause this is refused: keep working and submit with task_submit_result.',
}

export function checkpointHandlers(tool: CheckpointTool, sessionId: string) {
  // Identity is bound here, never taken from arguments (D7).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    task_checkpoint: async (input: unknown) => {
      const parsed = checkpointSchemas.task_checkpoint.parse(input)
      return tool.record(caller, {
        task_id: parsed.task_id, summary: parsed.summary, next_steps: parsed.next_steps,
        ...(parsed.commit !== undefined ? { commit: parsed.commit } : {}),
        ...(parsed.unfinished !== undefined ? { unfinished: parsed.unfinished } : {}),
        ...(parsed.errors_tests !== undefined ? { errors_tests: parsed.errors_tests } : {}),
      })
    },
  }
}
