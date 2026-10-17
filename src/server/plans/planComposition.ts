// The one production composition of the plan services (plan-validation D9's
// production wiring, extracted from ChatSessionManager so tests exercise the
// same construction the server runs): the ValidationService over the shared
// plan store, its adapter and capacity evidence, the coalesced validation
// view for the Plans page pushes, and the PlanService with validation's
// `validation-current` appended after the shipped approval preconditions.
// Both the manager and the test benches call `composePlanServices`; nothing
// else may wire these services by hand.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type { TeamIdentity } from '../team/teamIdentity'
import { loadGroupCatalog } from '../team/groupCatalog'
import type { StrategyStore } from '../strategy/strategyStore'
import type { ImpactService } from '../strategy/ImpactService'
import type { ValidationCapacityEvidence } from '../../shared/planValidation'
import type { PlanStore } from './planStore'
import { PlanService } from './PlanService'
import { OpenspecAdapter } from './validation/openspecAdapter'
import { ValidationService } from './validation/ValidationService'
import { ValidationStore } from './validation/validationStore'
import { ValidationDetailCache } from './validation/validationDetail'
import { ExecutionStore } from './execution/executionStore'
import { ExecutionService } from './execution/ExecutionService'
import { executionOwnership } from './execution/executionOwnership'
import { executionViews } from './execution/executionView'
import { REGISTERED_LANDING_MODES } from './landing/landingMechanisms'
import type { PlanExecutionSettings } from '../team/teamCaps'

/** What capacity evidence reads: staffing's counts and the cooldown ends (D3). */
export interface CapacityReads {
  capacity: (teamId: string, groupId: string, worktree: string) => { groupMembers: number; onProfile: Record<string, number> }
  cooldownUntil: (profileId: string) => string | null
}

export interface PlanServicesOptions {
  db: Database
  /** The mailbox's shared plan store — the same one the task link reads. */
  plans: PlanStore
  strategies: StrategyStore
  impact: ImpactService
  getSession: (id: string) => ChatSessionRecord | null | undefined
  /** The user-level settings (plan-execution D16); without it Start refuses on the missing floor map. */
  caps?: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
  /** Test seam: replace the execution pre-reads' validation standing (defaults to the composed service). */
  executionValidation?: {
    prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
    standing: (prepared: unknown) => unknown
  }
  /** Test seam: replace the landing probe (defaults to the real one). */
  executionProbe?: (input: import('./landing/landingProbe').ProbeInput, options?: import('./landing/ghCommand').GhCommandOptions) => Promise<import('./landing/landingProbe').ProbeResult>
  /** One adapter per manager by default (one 4-slot CLI pool per process). */
  adapter?: OpenspecAdapter
  /** Without staffing or limit reads, the capacity check shows no evidence row. */
  capacityReads?: CapacityReads
  homeDir?: string
}

/**
 * Capacity evidence for one role group (plan-validation D3): the group's
 * caps, live members, and cooling profiles with their cooldown end, read
 * from the team's OWN groups root — never re-resolved from the common git
 * dir, whose `.git` tail would miss project group files (M2). Evidence
 * only; never a blocker.
 */
export function capacityEvidenceFor(identity: TeamIdentity, group: string, reads: CapacityReads, homeDir?: string): ValidationCapacityEvidence | null {
  const entry = loadGroupCatalog({ groupsRoot: identity.groupsRoot, ...(homeDir ? { homeDir } : {}) }).groups.get(group)
  if (!entry) return null
  const capacity = reads.capacity(identity.teamId, group, identity.groupsRoot)
  return {
    group,
    max: entry.group.max,
    live: capacity.groupMembers,
    profiles: entry.group.profiles.map(profile => ({
      profile: profile.profileId,
      cap: profile.cap ?? null,
      live: capacity.onProfile[profile.profileId] ?? 0,
    })),
    cooling: entry.group.profiles
      .flatMap(profile => {
        const until = reads.cooldownUntil(profile.profileId)
        return until === null ? [] : [{ profile: profile.profileId, until }]
      }),
  }
}

/** The composed plan services: what ChatSessionManager and the benches construct. */
export function composePlanServices(options: PlanServicesOptions): {
  validation: ValidationService
  validationStore: ValidationStore
  plans: PlanService
  validationDetail: ValidationDetailCache
  adapter: OpenspecAdapter
  executions: ExecutionService
  executionStore: ExecutionStore
} {
  const adapter = options.adapter ?? new OpenspecAdapter()
  const validationStore = new ValidationStore(options.db)
  const validation = new ValidationService(validationStore, {
    plans: options.plans,
    strategies: options.strategies,
    impact: options.impact,
    adapter,
    getSession: options.getSession,
    capacity: options.capacityReads
      ? (team: TeamIdentity, group: string) => capacityEvidenceFor(team, group, options.capacityReads!, options.homeDir)
      : undefined,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  const executionStore = new ExecutionStore(options.db)
  // The real ownership (plan-execution D7/D9): the store reads, and the git
  // checks run over the real remote reads.
  const ownership = executionOwnership(executionStore, {
    isAncestor: (...args) => import('./landing/gitRemote').then(module => module.isAncestor(...args)),
    lsRemoteHead: (...args) => import('./landing/gitRemote').then(module => module.lsRemoteHead(...args)),
  }, messageId => {
    const row = options.db.prepare('SELECT from_kind FROM team_messages WHERE id = ?').get(messageId) as { from_kind?: string } | undefined
    return row?.from_kind === 'system' ? 'system' : row === undefined ? null : row.from_kind === 'human' ? 'human' : 'agent'
  })
  const plans = new PlanService(options.plans, {
    getSession: options.getSession,
    strategies: options.strategies,
    pinDisposition: (planId, revision) => options.impact.pinDisposition(planId, revision),
    validation: {
      prepareStanding: (planId, revision) => validation.prepareStanding(planId, revision),
      standing: prepared => validation.standing(prepared as Parameters<ValidationService['standing']>[0]),
      precondition: ValidationService.validationCurrentPrecondition(),
    },
    executionOf: executionId => {
      const execution = executionStore.execution(executionId)
      return execution ? { planId: execution.planId, revision: execution.revision } : null
    },
    executionsOf: planId => executionViews(executionStore, planId),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  const executions = new ExecutionService({
    store: executionStore,
    plansStore: options.plans,
    plans,
    validation: options.executionValidation ?? {
      prepareStanding: (planId: string, revision: number) => validation.prepareStanding(planId, revision),
      standing: (prepared: unknown) => validation.standing(prepared as Parameters<ValidationService['standing']>[0]),
    },
    impact: { gate: (planId, revision) => options.impact.gate(planId, revision) },
    settings: options.caps ?? { planExecution: async () => ({ floorChecks: null, maxParallelChanges: 3, mergeMethod: 'merge' }) },
    getSession: options.getSession,
    landingModes: () => new Set(REGISTERED_LANDING_MODES),
    ...(options.executionProbe ? { probe: options.executionProbe } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  void ownership
  return { validation, validationStore, plans, validationDetail: new ValidationDetailCache(validation), adapter, executions, executionStore }
}
