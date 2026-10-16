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
  const plans = new PlanService(options.plans, {
    getSession: options.getSession,
    strategies: options.strategies,
    pinDisposition: (planId, revision) => options.impact.pinDisposition(planId, revision),
    validation: {
      prepareStanding: (planId, revision) => validation.prepareStanding(planId, revision),
      standing: prepared => validation.standing(prepared as Parameters<ValidationService['standing']>[0]),
      precondition: ValidationService.validationCurrentPrecondition(),
    },
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  return { validation, validationStore, plans, validationDetail: new ValidationDetailCache(validation), adapter }
}
