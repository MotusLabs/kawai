// Start preconditions (plan-execution design D4, contract X5): the ordered
// list every Start evaluates inside its transaction. Each entry is
// `{ name, check(ctx) → string | null }` over a context ExecutionService
// builds from the pre-reads (probe, base comparison, groups) and fresh rows;
// every entry runs, and each failure contributes its name and an actionable
// message, so a refusal names every reason at once. Later changes append
// entries and never edit a shipped one.
import type { Plan, PlanRevision } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import type { ValidationStanding } from '../validation/validationStanding'
import { validationCurrentMessage } from '../validation/validationStanding'
import type { ProbeFinding } from '../landing/landingProbe'

export interface StartRequest {
  planId: string
  revision: number
  contentHash: string
  commandId: string
}

/** What roles-routable reads per change (D4): the implementing group's facts, pre-read from its file. */
export interface StartRoleFact {
  change: string
  group: string | null
  /** False when the group's current file is missing (not routable). */
  groupKnown: boolean
  /** False when the group sets worktreeScoped: false (execution dispatches worktree-scoped). */
  worktreeScoped: boolean
  /** The plan's role profiles for the group ∩ the group's own profiles; empty means no member could ever run. */
  sharedProfiles: string[]
}

/** Everything a Start precondition may read, built inside the Start transaction from the pre-reads and fresh rows. */
export interface StartCheckContext {
  plan: Plan
  /** The requested revision; null when it does not exist. */
  revision: PlanRevision | null
  request: StartRequest
  /** V5's standing, recomputed at Start; null when no validation service is wired. */
  validation: ValidationStanding | null
  /** The revision's strategy impact gate; null when the team has no strategy record. */
  impactGate: ImpactGate | null
  /** The plan's running execution, if any (one-execution; the index also enforces it). */
  runningExecution: { id: string } | null
  /** The team's owners of this plan's change names (changes-unclaimed; the index also enforces it). */
  claimedChanges: Array<{ change: string; executionId: string }>
  /** The pre-read changes-on-base diffs; empty when every file matches origin. */
  baseDiffs: Array<{ change: string; files: string[] }>
  /** The per-change role facts, pre-read from the groups' files. */
  roles: StartRoleFact[]
  /** The pre-read probe's findings; empty when landing is ready. */
  probeFindings: ProbeFinding[]
  /** The landing mode the plan's approved revision names. */
  landingMode: string
  /** The registry's registered mechanism modes (D13). */
  supportedLandingModes: ReadonlySet<string>
}

export interface StartPrecondition {
  name: string
  /** A message saying what to do, or null when the precondition holds. */
  check: (ctx: StartCheckContext) => string | null
}

const list = (items: string[]): string => items.join(', ')

/** The shipped Start preconditions, in order (D4). */
export const START_PRECONDITIONS: readonly StartPrecondition[] = [
  {
    name: 'plan-open',
    check: ({ plan }) => (plan.lifecycle === 'open' ? null : `The plan is ${plan.lifecycle}; reopen it before starting an execution.`),
  },
  {
    name: 'revision-current',
    check: ({ plan, revision, request }) => {
      if (!revision) return `Revision ${request.revision} does not exist.`
      if (revision.contentHash !== request.contentHash) {
        return `Revision ${request.revision}'s content hash is ${revision.contentHash}, not ${request.contentHash}: it differs from what was reviewed. Reload and start again.`
      }
      return plan.currentApprovedRevision === request.revision
        ? null
        : `Revision ${request.revision} is not the plan's approved revision (${plan.currentApprovedRevision ?? 'none'}). Approve it first.`
    },
  },
  {
    // V5's entry, message format unchanged (R06); absent validation passes as approval's does.
    name: 'validation-current',
    check: ({ validation }) => (validation === null ? null : validationCurrentMessage(validation)),
  },
  {
    name: 'start-conditions-resolved',
    check: ({ validation }) => {
      const report = validation !== null && 'report' in validation ? validation.report : null
      const carried = report?.readiness.carriedConditions.filter(condition => condition.gate === 'start' && !condition.resolved) ?? []
      if (carried.length === 0) return null
      return `Alignment conditions gate the start: ${carried.map(condition => condition.text).join(' ')}. Resolve them in the plan's validation view.`
    },
  },
  {
    name: 'strategy-impact',
    check: ({ impactGate }) => {
      if (impactGate === null || impactGate.pass) return null
      return `The revision's strategy pin needs a decision (${impactGate.state}); the Strategy tab's impact review decides it.`
    },
  },
  {
    name: 'one-execution',
    check: ({ runningExecution }) => (runningExecution === null
      ? null
      : `The plan already has a running execution (${runningExecution.id}). Stop it before starting another.`),
  },
  {
    name: 'changes-unclaimed',
    check: ({ claimedChanges }) => (claimedChanges.length === 0
      ? null
      : `Changes already owned by running executions: ${claimedChanges.map(row => `${row.change} (${row.executionId})`).join(', ')}.`),
  },
  {
    name: 'changes-on-base',
    check: ({ baseDiffs }) => (baseDiffs.length === 0
      ? null
      : `Artifacts differ from the base branch's head on origin: ${baseDiffs.map(diff => `${diff.change}: ${list(diff.files)}`).join('; ')}. Push the validated files or revalidate.`),
  },
  {
    name: 'roles-routable',
    check: ({ roles }) => {
      const failures: string[] = []
      for (const role of roles) {
        if (role.group === null) failures.push(`${role.change} has no implementing group.`)
        else if (!role.groupKnown) failures.push(`${role.change}'s group "${role.group}" is not defined; define it before starting.`)
        else if (!role.worktreeScoped) failures.push(`${role.change}'s group "${role.group}" is not worktree-scoped (worktreeScoped: false); execution dispatches worktree-scoped.`)
        else if (role.sharedProfiles.length === 0) failures.push(`${role.change}'s group "${role.group}" shares no profile with the plan's role.`)
      }
      return failures.length === 0 ? null : failures.join(' ')
    },
  },
  {
    name: 'landing-ready',
    check: ({ probeFindings }) => (probeFindings.length === 0
      ? null
      : `Landing is not ready: ${probeFindings.map(finding => finding.message).join(' ')}`),
  },
  {
    name: 'landing-mode-supported',
    check: ({ landingMode, supportedLandingModes }) => (supportedLandingModes.has(landingMode)
      ? null
      : `The landing mode "${landingMode}" is not registered; direct is the one this build ships.`),
  },
]

/** Run every entry; the failures, in list order (D4: every failing entry is reported at once). */
export function evaluateStartPreconditions(ctx: StartCheckContext): Array<{ name: string; message: string }> {
  const failures: Array<{ name: string; message: string }> = []
  for (const entry of START_PRECONDITIONS) {
    const message = entry.check(ctx)
    if (message !== null) failures.push({ name: entry.name, message })
  }
  return failures
}
