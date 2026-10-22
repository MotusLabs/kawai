// The supervision loader (plan-supervision design D10): reads one plan's
// newest execution from the stores and feeds the pure `changeSupervision`.
// Per change it loads the change row, its attempts, rounds (with the CI pass
// time and the deciding findings), effects (its own and the execution-level
// ones), the outstanding assignment's instruction mail, the landing fact and
// slot holder, its open cards, carried acceptance conditions, candidates,
// and result rows; dependencies are derived first, so each change sees their
// outcomes. The holder's session facts and the instruction's mailbox blocker
// are runtime facts, injected through `SupervisionRuntime`; `waitEndedAt` is
// the monitor's in-memory fact (D11), read through the optional `waitEndedAt`
// seam and null without it. Reads only, all in one read transaction (O1),
// so a write committing meanwhile is wholly in the view or wholly out of it.
import type { Database } from 'bun:sqlite'
import { cardState } from '../../../shared/planDecisions'
import { ciClass, runsByName } from '../../../shared/planExecutionGates'
import { changeSupervision, type ChangeSupervision, type HolderFacts, type SupervisionInput, type SupervisionOutcome, type SupervisionRound } from '../../../shared/planSupervision'
import { AssignmentStore, outstandingOf } from '../../team/assignmentStore'
import type { MailboxStore } from '../../team/mailboxStore'
import { TaskResultStore } from '../../team/taskResultStore'
import type { DecisionStore } from '../decisions/decisionStore'
import type { ExecutionRow, RoundRow } from '../execution/executionRows'
import type { ExecutionStore } from '../execution/executionStore'
import type { IntegrationStore } from '../landing/integration/integrationStore'
import type { PlanStore } from '../planStore'
import type { PlanRevision } from '../../../shared/plans'
import { agentHeldStage, attemptStatus } from '../execution/attemptStatus'

/** The runtime facts the session and mailbox modules expose (D10). */
export interface SupervisionRuntime {
  /** The instruction holder's facts; null when the session is unknown. */
  holder: (sessionId: string, taskId: string | null) => HolderFacts | null
  /** The mailbox waiting reason's immediate blocker for an unsettled message. */
  blocker: (messageId: string) => string | null
}

export interface SupervisionReads {
  db: Database
  mail: MailboxStore
  executions: ExecutionStore
  plans: Pick<PlanStore, 'forTeam' | 'revision' | 'approvedRevision'>
  decisions: DecisionStore
  integration?: IntegrationStore
  /** The execution's unresolved acceptance conditions (V2), as landing reads them. */
  conditionsOf: (executionId: string) => string[]
  runtime: SupervisionRuntime
  /** The monitor's last sight of the change in a named wait (D11, in memory); null without a monitor. */
  waitEndedAt?: (executionId: string, change: string) => string | null
}

export interface PlanSupervisionRead {
  /** The execution read, or null when the plan never started one. */
  executionId: string | null
  revision: number | null
  inputs: SupervisionInput[]
}

/** A round passed CI once its review was dispatched, or a carried round's verdict decided it. */
function ciPassedAt(round: RoundRow, reviewCreatedAt: string | null): string | null {
  const passed = round.reviewAssignmentId !== null || (round.carriedFrom !== null && round.outcome === 'pass')
  if (!passed || round.ci === null) return null
  const completed = [...runsByName(round.ci).values()].map(runs => runs.at(-1)!).filter(run => ciClass(run) === 'pass').map(run => run.completedAt)
    .filter((at): at is string => at !== null).sort().at(-1)
  return completed ?? reviewCreatedAt
}

function notStarted(change: string, dependsOn: string[]): SupervisionInput {
  return {
    change, dependsOn, state: null, step: null, stopReason: null, stopDetail: null, landing: null, dependencies: [], parallelLimit: null, attempt: null,
    rounds: [], effects: [], instruction: null, openCards: [], conditions: [], memberRelease: null, slotHolder: null, candidates: [], results: [], waitEndedAt: null,
  }
}

/** The plan's newest execution of the team and the revision it runs, else the current approved revision. */
export function supervisedRevision(reads: Pick<SupervisionReads, 'executions' | 'plans'>, teamId: string, planId: string): { execution: ExecutionRow | null; revision: PlanRevision | null } {
  const execution = reads.executions.executionsOf(planId).find(row => row.teamId === teamId) ?? null
  return { execution, revision: execution ? reads.plans.revision(planId, execution.revision) : reads.plans.approvedRevision(planId) }
}

/** Every change's input in the revision's order; dependency outcomes are filled by `readPlanSupervision`. */
export function readSupervisionInputs(reads: SupervisionReads, teamId: string, planId: string): PlanSupervisionRead | null {
  // One read transaction (O1): a write committing between these reads can
  // never show one change a fact another change's read missed.
  return reads.db.transaction(() => readInputs(reads, teamId, planId))()
}

function readInputs(reads: SupervisionReads, teamId: string, planId: string): PlanSupervisionRead | null {
  const plan = reads.plans.forTeam(teamId, planId)
  if (plan === null) return null
  const { execution, revision } = supervisedRevision(reads, teamId, planId)
  if (revision === null) return { executionId: execution?.id ?? null, revision: null, inputs: [] }
  const landings = new Map(reads.executions.landings(planId).map(row => [row.change, row]))
  const landingOf = (change: string): SupervisionInput['landing'] => {
    const row = landings.get(change)
    return row ? { landedAt: row.landedAt, treeVerified: row.treeVerified, mergeSha: row.mergeSha, postCi: row.postCi } : null
  }
  if (execution === null) {
    const inputs = revision.content.changes.map(entry => ({ ...notStarted(entry.change, entry.dependsOn), landing: landingOf(entry.change) }))
    return { executionId: null, revision: revision.revision, inputs }
  }
  const assignments = new AssignmentStore(reads.db, reads.mail)
  const results = new TaskResultStore(reads.db)
  const rows = new Map(reads.executions.changes(execution.id).map(row => [row.change, row]))
  const effects = reads.executions.effectsOf(execution.id)
  const slot = reads.executions.slot(teamId)
  const cards = reads.decisions.cardsOfPlan(teamId, planId)
  const conditions = reads.conditionsOf(execution.id)
  const candidates = reads.integration?.candidates(teamId, execution.baseBranch).filter(row => row.executionId === execution.id) ?? []
  try {
    const inputs = revision.content.changes.map((entry): SupervisionInput => {
      const row = rows.get(entry.change)
      if (row === undefined) return { ...notStarted(entry.change, entry.dependsOn), landing: landingOf(entry.change) }
      const taskAssignments = row.taskId ? assignments.listByTask(row.taskId) : []
      const created = new Map(taskAssignments.map(assignment => [assignment.id, assignment.createdAt]))
      const findings = new Map<string, { verdict: 'pass' | 'fail'; createdAt: string; findings: string }>()
      const loaded = new Set<string>()
      const rounds = reads.executions.rounds(execution.id, entry.change).map((round): SupervisionRound => {
        let verdict = null as { verdict: 'pass' | 'fail'; createdAt: string; findings: string } | null
        if (round.verdictFindingsId !== null) {
          if (!loaded.has(round.resultId)) for (const found of results.findingsFor(round.resultId)) findings.set(found.id, found)
          loaded.add(round.resultId)
          verdict = findings.get(round.verdictFindingsId) ?? null
        }
        return {
          id: round.id, number: round.number, outcome: round.outcome, decidedAt: round.decidedAt, carriedFrom: round.carriedFrom, ci: round.ci,
          ciPassedAt: ciPassedAt(round, round.reviewAssignmentId ? created.get(round.reviewAssignmentId) ?? null : null),
          verdict: verdict?.verdict ?? null, verdictAt: verdict?.createdAt ?? null, findingsSummary: verdict?.findings ?? null,
        }
      })
      // O3′ (revision-control PR E): the one agent-held predicate. An owed
      // newest attempt names no holder — the outstanding assignment would be
      // the previous stage's, so the instruction reads null instead.
      const newest = reads.executions.attempts(execution.id, entry.change).at(-1) ?? null
      const attempt = newest === null ? null : {
        kind: newest.kind,
        status: attemptStatus(newest, taskAssignments, reads.executions.rounds(execution.id, entry.change)),
      }
      const agentHeld = agentHeldStage(row, attempt) !== null
      const outstanding = agentHeld ? outstandingOf(taskAssignments) : null
      const message = outstanding?.messageId ? reads.mail.get(outstanding.messageId) : null
      const holderId = message?.claimedBy ?? (outstanding?.targetKind === 'session' ? outstanding.targetId : null)
      const decided = (cardId: string) => cardState(reads.decisions.decisionsOfCard(teamId, cardId)) !== 'open'
      return {
        change: entry.change,
        dependsOn: entry.dependsOn,
        state: row.state,
        step: row.step,
        stopReason: row.stopReason,
        stopDetail: row.stopDetail,
        landing: landingOf(entry.change),
        dependencies: [],
        parallelLimit: execution.maxParallel,
        attempt,
        rounds,
        effects: effects.filter(effect => effect.change === entry.change || effect.change === null)
          .map(effect => ({ kind: effect.kind, state: effect.state, tries: effect.tries, nextAt: effect.nextAt })),
        instruction: outstanding === null ? null : {
          messageId: outstanding.messageId,
          state: message?.state ?? 'missing',
          deliveredAt: message?.deliveredAt ?? null,
          blocker: message ? reads.runtime.blocker(message.id) : null,
          holder: holderId ? reads.runtime.holder(holderId, row.taskId) : null,
        },
        openCards: row.taskId === null ? [] : cards.filter(card => card.taskId === row.taskId && !decided(card.id))
          .map(card => ({ cardId: card.id, addressedTo: card.addressedTo, addressedGroup: card.addressedGroup })),
        conditions,
        memberRelease: row.step === 'releasing' && row.stopDetail?.session
          ? { member: row.stopDetail.session, reason: row.stopDetail.message ?? 'a member is not ready to release' } : null,
        slotHolder: slot ? { kind: slot.holderKind, id: slot.holderId } : null,
        candidates: candidates.filter(candidate => candidate.change === entry.change).map(candidate => ({ state: candidate.state, createdAt: candidate.createdAt, decidedAt: candidate.decidedAt })),
        results: row.taskId === null ? [] : results.listByTask(row.taskId).map(result => ({ createdAt: result.createdAt })),
        waitEndedAt: reads.waitEndedAt?.(execution.id, entry.change) ?? null,
      }
    })
    return { executionId: execution.id, revision: revision.revision, inputs }
  } finally {
    assignments.close()
  }
}

/** Each change's derived supervision in the revision's order, dependencies before their dependents. */
export function readPlanSupervision(reads: SupervisionReads, teamId: string, planId: string, now: Date): ChangeSupervision[] {
  return derivePlanSupervision(reads, teamId, planId, now)?.changes ?? []
}

/** The loader's read with each change's derivation beside its input; null for another team's or an unknown plan. */
export function derivePlanSupervision(reads: SupervisionReads, teamId: string, planId: string, now: Date): (PlanSupervisionRead & { changes: ChangeSupervision[] }) | null {
  const read = readSupervisionInputs(reads, teamId, planId)
  if (read === null) return null
  const byChange = new Map(read.inputs.map(input => [input.change, input]))
  const derived = new Map<string, ChangeSupervision>()
  const visiting = new Set<string>()
  const derive = (change: string): SupervisionOutcome => {
    const known = derived.get(change)
    if (known) return known.outcome
    const input = byChange.get(change)
    // A dependency outside the revision, or a cycle (refused at save), reads not started.
    if (input === undefined || visiting.has(change)) return 'not-started'
    visiting.add(change)
    const dependencies = input.dependsOn.map(dependency => ({ change: dependency, outcome: derive(dependency) }))
    visiting.delete(change)
    const supervision = changeSupervision({ ...input, dependencies }, now)
    derived.set(change, supervision)
    return supervision.outcome
  }
  for (const input of read.inputs) derive(input.change)
  return { ...read, changes: read.inputs.map(input => derived.get(input.change)!) }
}
