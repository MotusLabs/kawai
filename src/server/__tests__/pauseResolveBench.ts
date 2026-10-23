// The shared fixtures behind the resolve suites (revision-control 4.4, A3's
// C-rows and A-rows): the pauseTargetsBench wiring plus the row builders and
// the paused-target worlds every row test and the model test share. Split so
// each suite stays under 500 lines (the CP2a B4 precedent).
import type { AttemptKind, AttemptManifest } from '../../shared/planExecution'
import { expect } from 'bun:test'
import type { TeamMessage } from '../../shared/team'
import { type ResolveInput, type PauseResolveOutcome } from '../plans/revisionControl/pauseResolve'
import { PLAN_RESUME_TAG } from '../plans/revisionControl/pauseResolveResume'
import type { PlanPauseTarget } from '../../shared/planRevisionControl'
import { applyRoundStage, roundAdapters, type RoundDeps } from '../plans/execution/executionRounds'
import { TaskResultService } from '../team/TaskResultService'
import { pauseTargetsBench, type PauseTargetsBench } from './pauseTargetsBench'
import { sessionRow, writeGroup } from './planHarness'

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

export type PauseResolveBench = PauseTargetsBench & {
  /** One human resolve with a fresh command id unless one is given; async for L3's pre-transaction head read. */
  resolve: (input: Partial<ResolveInput> & { planId: string; pauseId: string; change: string }) => Promise<PauseResolveOutcome>
  /** The plan-resume mails on the change task. */
  resumeMails: (taskId: string) => TeamMessage[]
  /** The plan's `pause-resolved` events. */
  resolvedEvents: (planId: string) => Array<Record<string, unknown>>
  /** Record Paused the way the tick's guarded write does. */
  toPaused: (pauseId: string, change: string) => void
  /** Mint an owed attempt row (assignment unlinked, no key sent) — the G4 post-creation path. */
  mintOwed: (executionId: string, change: string, kind: AttemptKind, manifest?: AttemptManifest) => string
  /** Mint a dispatched attempt row: mail, assignment, and the linked row, claimed by `holder`. */
  mintAttempt: (executionId: string, change: string, kind: AttemptKind, holder?: string, manifest?: AttemptManifest) => Promise<{ taskId: string; assignmentId: string }>
  /** Record the newest attempt's round with a result pinning `taskRevision`. Returns the round id. */
  answerNewestRow: (executionId: string, change: string, taskRevision: number) => string
  /** The same recording through the production round stage (`applyRoundStage`'s `result` branch) — L4's forcing path for the answered-after-pause cells. */
  answerNewestRowViaStage: (executionId: string, change: string, taskRevision: number) => Promise<string>
  /** Publish the next task revision (notify: false — no notices in the bench). */
  republish: (taskId: string, direction?: string) => void
  /** An in-flight change, held, paused, and recorded Paused — C2's base world. */
  pausedAttempt: (opts?: { holder?: string; mintAttempt?: boolean }) => Promise<{ planId: string; executionId: string; taskId: string; assignmentId: string; pauseId: string }>
  /** A review target (gating, reviewing) recorded Paused, with the C12-C14 variants. The round's handoff is dispatched through the production review stage (`applyRoundStage`'s review branch — `round.reviewAssignmentId` is a store fact) and claimed by reviewer session `rev1`, so the target derives a live holder. */
  pausedReview: (opts?: { superseded?: boolean; notes?: boolean; pending?: boolean }) => Promise<{ planId: string; executionId: string; taskId: string; pauseId: string }>
  /** The update target (gating, newest update row out) recorded Paused. */
  pausedUpdate: (opts?: { manifest?: AttemptManifest }) => Promise<{ planId: string; executionId: string; taskId: string; updateAssignmentId: string; pauseId: string }>
  /** The fixture's RoundDeps, with an optional review-restart seam — the release test runs the planner's stage through it. */
  roundDeps: (reviewRestart?: RoundDeps['reviewRestart']) => RoundDeps
  /** A still-pausing target — the pause placed, Paused not recorded (R10-R15's base world). `checkpoint` plants THIS pause's own newest checkpoint, kind `commit` with its push effect in `effectState` (undefined = no effect row) or kind `result` (work on origin). */
  pausing: (opts?: { holder?: string; queued?: boolean; withdrawn?: boolean; checkpoint?: { kind: 'commit'; effectState?: 'done' | 'failed' | 'running' } | { kind: 'result' } }) => Promise<{ planId: string; executionId: string; taskId: string; assignmentId: string; pauseId: string }>
}

export async function pauseResolveBench(prefix: string): Promise<PauseResolveBench> {
  const wired = await pauseTargetsBench(prefix)
  // The plan fixtures name `reviewers` as the review group; the production
  // dispatch addresses it as a group target, so the bench defines it once
  // (the restart suites each wrote it before the fixture built the real
  // review cell).
  writeGroup(wired.world, 'reviewers', 'Review work.')
  let commandCounter = 0
  const resolve = async (input: Partial<ResolveInput> & { planId: string; pauseId: string; change: string }): Promise<PauseResolveOutcome> =>
    wired.service.resolve(wired.bench.human, { rationale: 'rethink', commandId: `resolve-${++commandCounter}`, ...input } as ResolveInput)
  const resumeMails = (taskId: string): TeamMessage[] =>
    wired.bench.mail.forTask(taskId).filter(message => message.tags.includes(PLAN_RESUME_TAG))
  const resolvedEvents = (planId: string): Array<Record<string, unknown>> =>
    wired.bench.db.db.prepare("SELECT * FROM plan_events WHERE plan_id = ? AND kind = 'pause-resolved' ORDER BY rowid").all(planId) as Array<Record<string, unknown>>
  const toPaused = (pauseId: string, change: string): void => {
    const written = wired.pauses.recordPaused(pauseId, change, null)
    if (!written.written) throw new Error(`recording Paused for ${change} wrote nothing`)
  }
  const mintOwed = (executionId: string, change: string, kind: AttemptKind, manifest?: AttemptManifest): string =>
    wired.executions.insertAttempt({ executionId, change, kind, assignmentId: null, manifest: manifest ?? wired.manifest(), manifestHash: 'mh' }).id
  const mintAttempt = async (executionId: string, change: string, kind: AttemptKind, holder = 'dev2', manifest?: AttemptManifest): Promise<{ taskId: string; assignmentId: string }> => {
    const taskId = wired.executions.change(executionId, change)!.taskId!
    const message = wired.bench.mail.enqueue({
      teamId: wired.teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
      originPath: wired.world.repo, body: `Work ${change} (${kind}).`, taskId, actor: 'human',
    })
    const inserted = wired.bench.assignmentStore.insert({
      teamId: wired.teamId, taskId, requestKey: `rk-${change}-${kind}-${++commandCounter}`, targetKind: 'session', targetId: holder,
      role: null, instruction: `Work ${change}.`, creator: { kind: 'human', sessionId: null }, messageId: message.id,
    })
    wired.bench.mail.claim(message.id, holder)
    wired.executions.insertAttempt({ executionId, change, kind, assignmentId: inserted.assignment.id, manifest: manifest ?? wired.manifest(), manifestHash: 'mh' })
    return { taskId, assignmentId: inserted.assignment.id }
  }
  const answerNewestRow = (executionId: string, change: string, taskRevision: number): string => {
    const row = wired.executions.change(executionId, change)!
    const attempt = wired.executions.attempts(executionId, change).at(-1)!
    const result = wired.tasks.store.results.insert({
      teamId: wired.teamId, taskId: row.taskId!, summary: 'done', commit: 'round-commit', diff: null, worktree: null,
      tests: [], limitations: null, taskRevision, submittedBy: { kind: 'agent', sessionId: 'dev' },
    })
    return wired.executions.insertRound({ executionId, change, attemptId: attempt.id, resultId: result.id, commitSha: 'round-commit', fixRound: false }).round.id
  }
  /** The RoundDeps the fixture's stage paths share (L4, and LC1's review cell): the bench stores behind the production round pipeline's shape, a ready release seam, no hold gate. The review branch's handoff dispatches through the same AssignmentService the resolve reads. */
  const roundDeps = (reviewRestart?: RoundDeps['reviewRestart']): RoundDeps => ({
    team: wired.world.team, repo: wired.world.repo, executions: wired.executions, plans: wired.bench.plans,
    tasks: wired.tasks,
    results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id) ?? null, assignments: wired.assignments }),
    assignments: wired.assignments, adapters: roundAdapters,
    releases: {
      readiness: () => ({ ready: true, reason: null }),
      release: () => ({ ok: true }),
      pendingSpawns: () => [],
    },
    groupScoped: () => false, records: () => wired.bench.records.values(), now: () => wired.now().toISOString(),
    ...(reviewRestart ? { reviewRestart } : {}),
  })
  /** Record the newest attempt's round the way the executor settles a holder's result (L4): the result row is the production store insert, and the round is written by `applyRoundStage`'s `result` branch — the production result-recording function — not by hand-minting the row. The answered-after-pause cells (C18/C19/A14r) build exactly here. */
  const answerNewestRowViaStage = async (executionId: string, change: string, taskRevision: number): Promise<string> => {
    const row = wired.executions.change(executionId, change)!
    const result = wired.tasks.store.results.insert({
      teamId: wired.teamId, taskId: row.taskId!, summary: 'done', commit: 'round-commit', diff: null, worktree: null,
      tests: [], limitations: null, taskRevision, submittedBy: { kind: 'agent', sessionId: 'dev' },
    })
    await applyRoundStage(roundDeps(), row, { kind: 'result', roundId: null, resultId: result.id })
    return wired.executions.rounds(executionId, change).at(-1)!.id
  }
  const republish = (taskId: string, direction = 'Revised: rework the shape'): void => {
    const outcome = wired.tasks.store.publish(taskId, { direction, rationale: 'the lead rethought it', notify: false }, { kind: 'human', sessionId: null })
    if (outcome === null) throw new Error('the revision publication wrote nothing')
  }
  // The paused-target worlds. A round row is never minted before the pause:
  // recording one advances the change to `gating`, where it derives no
  // target, so every answered-round world answers after the pause (the
  // model suite's variants do the same).
  let fixtureSequence = 0
  const pausedAttempt = async (opts: { holder?: string; mintAttempt?: boolean } = {}): Promise<{ planId: string; executionId: string; taskId: string; assignmentId: string; pauseId: string }> => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const flight = await wired.inFlight(executionId, 'api', opts.holder ?? 'dev', 'claim', opts.mintAttempt ?? true)
    const hold = wired.placeHold(planId, ['api'], `hold-${++fixtureSequence}`)
    const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++fixtureSequence}` })).pause
    toPaused(pause.id, 'api')
    return { planId, executionId, taskId: flight.taskId, assignmentId: flight.assignmentId, pauseId: pause.id }
  }
  const pausedReview = async (opts: { superseded?: boolean; notes?: boolean; pending?: boolean } = {}): Promise<{ planId: string; executionId: string; taskId: string; pauseId: string }> => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const flight = await wired.inFlight(executionId, 'api', 'dev2')
    const roundId = answerNewestRow(executionId, 'api', 1)
    const row = wired.executions.change(executionId, 'api')!
    expect(wired.executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    // LC1's fixture: the review cell is built the production way — the
    // round's handoff is dispatched by `applyRoundStage`'s review branch, so
    // `round.reviewAssignmentId` and the supersede-able assignment row are
    // real store facts, never hand-minted ones.
    const reviewing = wired.executions.change(executionId, 'api')!
    await applyRoundStage(roundDeps(), reviewing, { kind: 'review', roundId, resultId: null })
    const round = wired.executions.round(roundId)!
    const handoff = round.reviewAssignmentId === null ? null : wired.bench.assignmentStore.byId(round.reviewAssignmentId)
    if (handoff === null || handoff.messageId === null) throw new Error('the fixture review dispatch wrote no handoff')
    // A live holder: reviewer session `rev1` claims the group handoff, so
    // the paused target derives one (a queued handoff reads withdrawn, and
    // C12's continue would refuse).
    wired.bench.records.set('rev1', sessionRow('rev1', 'reviewers', wired.world.feature))
    wired.bench.mail.claim(handoff.messageId, 'rev1')
    const hold = wired.placeHold(planId, ['api'], `hold-${++fixtureSequence}`)
    const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++fixtureSequence}` })).pause
    if (opts.notes) {
      wired.checkpoints.insert({
        executionId, change: 'api', pauseId: pause.id, attemptId: null, sessionId: 'rev1', kind: 'notes', commitSha: null,
        baselineCommit: null, manifestHash: null, resultId: null, summary: 'the review notes', unfinished: null,
        errorsTests: null, nextSteps: 'none', effectId: null,
      })
    }
    toPaused(pause.id, 'api')
    // Superseded after the recording: the stored target is not stamped
    // withdrawn (that would refuse C9 before the review branch) — the
    // superseded handoff is read live from the assignment rows at resolve time.
    if (opts.superseded) wired.bench.assignmentStore.supersede(targetOf(wired, pause.id, 'api').assignmentId, 'successor')
    if (opts.pending) republish(flight.taskId)
    return { planId, executionId, taskId: flight.taskId, pauseId: pause.id }
  }
  const pausedUpdate = async (opts: { manifest?: AttemptManifest } = {}): Promise<{ planId: string; executionId: string; taskId: string; updateAssignmentId: string; pauseId: string }> => {
    const { planId, executionId } = await wired.executionWith(['api'])
    await wired.inFlight(executionId, 'api', 'dev')
    answerNewestRow(executionId, 'api', 1)
    const update = await mintAttempt(executionId, 'api', 'update', 'dev3', opts.manifest)
    const row = wired.executions.change(executionId, 'api')!
    expect(wired.executions.transition(executionId, 'api', row, { state: 'gating', step: null })).not.toBeNull()
    const hold = wired.placeHold(planId, ['api'], `hold-${++fixtureSequence}`)
    const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++fixtureSequence}` })).pause
    toPaused(pause.id, 'api')
    return { planId, executionId, taskId: update.taskId, updateAssignmentId: update.assignmentId, pauseId: pause.id }
  }
  // R10-R15's base world: the pause placed, the tick never run — the target
  // is still pausing, carrying whatever causes its facts derive. The
  // optional checkpoint is THIS pause's own newest one (keyed by the pause
  // id, D5), planted the way the checkpoint tool records one: a `commit`
  // checkpoint carries its push-checkpoint effect in `effectState`
  // (undefined = the effect row never existed), a `result` checkpoint is
  // work on origin outright. `withdrawn` marks the target withdrawn before
  // the tick (R15 — the store row the service's own paths never leave,
  // since a withdrawal records Paused beside it, D6).
  const pausing = async (opts: { holder?: string; queued?: boolean; withdrawn?: boolean;
      checkpoint?: { kind: 'commit'; effectState?: 'done' | 'failed' | 'running' } | { kind: 'result' } } = {}):
    Promise<{ planId: string; executionId: string; taskId: string; assignmentId: string; pauseId: string }> => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const flight = await wired.inFlight(executionId, 'api', opts.holder ?? 'dev', opts.queued === true ? 'queued' : 'claim')
    const hold = wired.placeHold(planId, ['api'], `hold-${++fixtureSequence}`)
    const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++fixtureSequence}` })).pause
    if (opts.checkpoint !== undefined && opts.checkpoint.kind === 'commit' && opts.checkpoint.effectState !== undefined) {
      const effect = wired.executions.insertEffect({ executionId, change: 'api', roundId: null, kind: 'push-checkpoint', effectKey: `push-checkpoint:${pause.id}`, command: {} })
      const state = opts.checkpoint.effectState
      if (state === 'running') wired.executions.markEffectRunning(effect.id)
      else wired.executions.setEffectOutcome(effect.id, { state, outcome: {}, error: state === 'failed' ? 'the push refused' : null })
      wired.checkpoints.insert({
        executionId, change: 'api', pauseId: pause.id, attemptId: null, sessionId: 'dev', kind: 'commit',
        commitSha: 'checkpoint-sha', baselineCommit: null, manifestHash: null, resultId: null,
        summary: 'the holder checkpoint', unfinished: null, errorsTests: null, nextSteps: 'none',
        effectId: effect.id,
      })
    } else if (opts.checkpoint !== undefined && opts.checkpoint.kind === 'result') {
      wired.checkpoints.insert({
        executionId, change: 'api', pauseId: pause.id, attemptId: null, sessionId: 'dev', kind: 'result',
        commitSha: 'checkpoint-sha', baselineCommit: null, manifestHash: null, resultId: null,
        summary: 'the holder checkpoint', unfinished: null, errorsTests: null, nextSteps: 'none',
        effectId: null,
      })
    }
    if (opts.withdrawn === true) {
      wired.bench.db.db.prepare('UPDATE plan_pause_targets SET withdrawn = 1 WHERE pause_id = ? AND change = ?').run(pause.id, 'api')
    }
    return { planId, executionId, taskId: flight.taskId, assignmentId: flight.assignmentId, pauseId: pause.id }
  }
  return { ...wired, resolve, resumeMails, resolvedEvents, toPaused, mintOwed, mintAttempt, answerNewestRow, answerNewestRowViaStage, republish, pausedAttempt, pausedReview, pausedUpdate, pausing, roundDeps }
}

/** The pause target of `change` on the pause, asserted present. */
export function targetOf(bench: PauseTargetsBench, pauseId: string, change: string): PlanPauseTarget {
  const target = bench.pauses.target(pauseId, change)
  if (target === null) throw new Error(`the pause has no target for ${change}`)
  return target
}
