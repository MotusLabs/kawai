// The executor's pause pass (revision-control 4.3, design D8): every open
// pause of the team, each tick. The owed pause mail goes first (the pause
// service's once-markered pass — a spawn's claim, a forward's successor),
// then each target's stored record (newest checkpoint, its push effect) and
// the holder's live facts feed the pure `pauseTargetState`, and Paused is
// recorded through the guarded write when the work is on `origin` and the
// holder is ready — an archived holder counts as ready, a killed one only
// once its checkpoint reached `origin`. The pass closes a settled pause:
// every target decided, or the execution finished (read as `cancelled`).
// Recovery state lives in the rows alone: a restart re-derives Pausing from
// the same stored rows and re-runs the same guarded writes, so it never
// resumes a holder blindly and never shows a Paused state that was not
// recorded (R18).
import { logger } from '../../logger'
import type { ChatSessionRecord } from '../../db'
import type { MailboxStore } from '../../team/mailboxStore'
import type { PlanPause, PlanPauseTarget, PauseTargetState } from '../../../shared/planRevisionControl'
import type { ExecutionStore } from '../execution/executionStore'
import type { CheckpointStore } from './checkpointStore'
import type { PauseStore } from './pauseStore'
import { pauseTargetState, workOnOrigin, type PauseTargetFacts, type PauseTargetRecord } from './pauseState'

/** One holder's live facts, as the pause tick reads them (D8's causes). */
export interface PauseHolderRuntimeFacts {
  /** The session record's state: a missing record is killed, an archived one stays. */
  state: 'live' | 'archived' | 'killed'
  /** A pending approval or question (the `request` cause, R11). */
  pendingRequest: boolean
  /** A turn, a live worker, or a running background task (the `busy` cause). */
  busy: boolean
  /** The provider limit: the cooling end, else a parked row's resume; null when neither (D6). */
  providerLimit: { profile: string | null; resetAt: string | null } | null
}

/** The reads `pauseHolderFacts` builds the holder facts from — the manager's, beside the supervision runtime's. */
export interface PauseHolderFactsDeps {
  getRecord: (sessionId: string) => ChatSessionRecord | undefined
  pendingRequest: (sessionId: string) => boolean
  hasLiveWorkers: (sessionId: string) => boolean
  hasRunningBackgroundTasks: (sessionId: string) => boolean
  /** Parked work keeps its resume (the provider limit's reset, D6). */
  parkedResumes: (sessionId: string) => Array<string | null>
  /** The record's profile cooldown end (the router's rule); null when not cooling. */
  cooldownUntil: (record: ChatSessionRecord) => string | null
}

/** The holder facts the manager wires for the tick: killed reads gone, cooling wins over parked. */
export function pauseHolderFacts(deps: PauseHolderFactsDeps): (sessionId: string) => PauseHolderRuntimeFacts {
  return sessionId => {
    const record = deps.getRecord(sessionId)
    if (record === undefined) return { state: 'killed', pendingRequest: false, busy: false, providerLimit: null }
    const profile = record.claudeProfileId ?? 'default'
    const cooling = deps.cooldownUntil(record)
    if (cooling !== null) {
      return {
        state: record.archivedAt != null ? 'archived' : 'live',
        pendingRequest: deps.pendingRequest(sessionId), busy: busyOf(deps, sessionId, record),
        providerLimit: { profile, resetAt: cooling },
      }
    }
    const resumes = deps.parkedResumes(sessionId).filter((at): at is string => at !== null).sort()
    return {
      state: record.archivedAt != null ? 'archived' : 'live',
      pendingRequest: deps.pendingRequest(sessionId), busy: busyOf(deps, sessionId, record),
      providerLimit: resumes.length === 0 ? null : { profile, resetAt: resumes[resumes.length - 1]! },
    }
  }
}

const busyOf = (deps: PauseHolderFactsDeps, sessionId: string, record: ChatSessionRecord): boolean =>
  record.status === 'working' || deps.hasLiveWorkers(sessionId) || deps.hasRunningBackgroundTasks(sessionId)

/** The tick's pause pass over one team (D8): the deps the composition wires. */
export interface PauseTickDeps {
  pauses: PauseStore
  checkpoints: CheckpointStore
  executions: ExecutionStore
  /** The pause mail's delivery state (the `awaiting-delivery` cause). */
  mailbox: Pick<MailboxStore, 'get'>
  /** The owed pause mail (D6), through the pause service's once-markered pass. */
  deliverOwed: (teamId: string, groupsRoot: string, pauseId: string) => string[]
  /** Member release's one readiness answer, for a live holder (D8's holder-ready rule). */
  readiness: (sessionId: string) => { ready: boolean; reason: string | null }
  /** The live holder facts (`pauseHolderFacts`). */
  factsOf: (sessionId: string) => PauseHolderRuntimeFacts
  now?: () => Date
}

/**
 * One pass over the team's open pauses. Per-pause isolation: a failing pass
 * is logged and the next tick retries it, never starving the other pauses.
 */
export function runPauseTick(deps: PauseTickDeps, teamId: string, groupsRoot: string): void {
  const now = deps.now?.() ?? new Date()
  for (const pause of deps.pauses.forTeam(teamId, true)) {
    try {
      pausePass(deps, pause, groupsRoot, now)
    } catch (error) {
      logger.warn('plan_pause_tick_failed', { teamId, pauseId: pause.id, error: String(error) })
    }
  }
}

function pausePass(deps: PauseTickDeps, pause: PlanPause, groupsRoot: string, now: Date): void {
  deps.deliverOwed(teamIdOf(pause), groupsRoot, pause.id)
  const execution = deps.executions.execution(pause.executionId)
  const finished = execution !== null && execution.state !== 'running'
  for (const target of deps.pauses.targets(pause.id)) {
    if (target.decision !== null || target.pausedAt !== null) continue
    const { record, facts } = derivePauseTarget(deps, pause, target, finished, now)
    // D8's recording rule, nothing else records Paused: the guarded write
    // arbitrates a repeat, so the first tick's fact is the one that stands.
    if (workOnOrigin(record) && facts.readiness.ready) deps.pauses.recordPaused(pause.id, target.change, target.checkpointId)
  }
  deps.pauses.closeIfSettled(pause.id, finished)
}

const teamIdOf = (pause: PlanPause): string => pause.teamId

/**
 * One target's stored record, live facts, and derived state — what the tick
 * records from, and what a read model (D14) renders the causes from. The
 * state comes from the pure `pauseTargetState`; this adds only the reads.
 */
export function derivePauseTarget(deps: PauseTickDeps, pause: PlanPause, target: PlanPauseTarget, executionFinished: boolean, now: Date): { record: PauseTargetRecord; facts: PauseTargetFacts; state: PauseTargetState } {
  const record = storedRecord(deps, pause.executionId, target)
  const facts = targetFacts(deps, pause, target, executionFinished, now)
  return { record, facts, state: pauseTargetState(record, facts) }
}

/**
 * The stored record the pure state reads (D8): the newest checkpoint's kind
 * and its `push-checkpoint` effect's settled state — a superseded checkpoint
 * never speaks for the target.
 */
function storedRecord(deps: PauseTickDeps, executionId: string, target: PlanPauseTarget): PauseTargetRecord {
  const checkpoint = deps.checkpoints.newest(target.pauseId, target.change)
  const effect = checkpoint !== null && checkpoint.effectId !== null
    ? deps.executions.effectsOf(executionId).find(entry => entry.id === checkpoint.effectId) ?? null
    : null
  return {
    stage: target.stage,
    holderSession: target.holderSession,
    withdrawn: target.withdrawn,
    pausedAt: target.pausedAt,
    decision: target.decision,
    checkpointKind: checkpoint?.kind ?? null,
    pushEffectState: effect?.state ?? null,
  }
}

/**
 * The facts around one target. A killed holder's readiness is the origin
 * rule itself — it counts as ready only once its work is on `origin`, and
 * `holder-killed` names it otherwise — and an archived holder counts as
 * ready (D8), so only a live holder consults member release here.
 */
function targetFacts(deps: PauseTickDeps, pause: PlanPause, target: PlanPauseTarget, executionFinished: boolean, now: Date): PauseTargetFacts {
  const holderSession = target.holderSession
  const live = holderSession === null ? null : deps.factsOf(holderSession)
  const message = target.messageId === null ? null : deps.mailbox.get(target.messageId)
  const ready = holderSession === null || live === null || live.state !== 'live'
    ? { ready: true, reasons: [] }
    : (() => {
        const answer = deps.readiness(holderSession)
        return answer.ready ? { ready: true, reasons: [] as string[] } : { ready: false, reasons: [answer.reason ?? 'not ready'] }
      })()
  return {
    executionFinished,
    messageDelivered: message !== null && message.state === 'delivered',
    spawnUnclaimed: holderSession === null && target.messageId === null,
    pendingRequest: live?.pendingRequest ?? false,
    busy: live?.busy ?? false,
    providerLimit: live?.providerLimit ?? null,
    holder: live?.state ?? 'live',
    readiness: ready,
    deadlinePassed: Date.parse(pause.deadline) <= now.getTime(),
  }
}
