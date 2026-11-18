// Apply preconditions (plan-revision-apply design D3, AP1–AP17): the ordered,
// append-only list every Apply evaluates inside its transaction, and its
// preview evaluates over the same reads. Each entry is `{ name, check(ctx) →
// string | null }`; every entry runs, so a refusal names every failing entry
// in list order (AP16). Six entries reuse Start's own (`validation-current`,
// `start-conditions-resolved`, `strategy-impact`, `changes-unclaimed`,
// `changes-on-base`, `roles-routable`) over contexts narrowed to the changes
// D3 names for them; the rest are Apply's. Later changes append entries and
// never edit a shipped one.
import type { Plan, PlanContent, PlanRevision } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import type { DeltaChange, RevisionDelta } from '../../../shared/planRevisionControl'
import type { ValidationStanding } from '../validation/validationStanding'
import type { ExecutionRow } from '../execution/executionRows'
import { START_PRECONDITIONS, type StartCheckContext, type StartRoleFact } from '../execution/startPreconditions'

export const APPLY_CHOICES = ['continue', 'adapt', 'restart'] as const
export type ApplyChoice = typeof APPLY_CHOICES[number]

/** The compared Apply payload (D3), as the command carries it. */
export interface ApplyRequest {
  executionId: string
  expectedRevision: number
  revision: number
  contentHash: string
  /** One choice per changed change that has a task. */
  choices: Record<string, string>
  /** Adapt texts by change; an omitted one takes the generated text (D5). */
  adaptations?: Record<string, string>
  rationale: string
}

/** Everything an Apply precondition reads: the prepare phase's reads plus the transaction's fresh rows. */
export interface ApplyCheckContext {
  plan: Plan
  execution: ExecutionRow
  request: ApplyRequest
  /** The requested revision; null when it does not exist. */
  target: PlanRevision | null
  /** The execution's current revision's content; null when its row is missing. */
  running: PlanContent | null
  /** `revisionDelta(running, target)`; null when either revision is missing. */
  delta: RevisionDelta | null
  validation: ValidationStanding | null
  impactGate: ImpactGate | null
  /** Changed or removed changes with a merge or fast-forward effect in flight (merge-quiet). */
  liveMerges: string[]
  /** Added changes owned by another running execution (changes-unclaimed). */
  claimedChanges: Array<{ change: string; executionId: string }>
  /** The pre-read blob diffs of the added, adapted, and restarted changes. */
  baseDiffs: Array<{ change: string; files: string[] }>
  /** The role facts of the target's unlanded changes. */
  roles: StartRoleFact[]
}

export interface ApplyPrecondition {
  name: string
  check: (ctx: ApplyCheckContext) => string | null
}

/** The changes of a delta in one class. */
export const deltaOf = (delta: RevisionDelta | null, cls: DeltaChange['class']): DeltaChange[] =>
  delta?.changes.filter(change => change.class === cls) ?? []

/** The changed changes that need an owner choice: changed, with a task (D2). */
export const neededChoices = (delta: RevisionDelta | null): string[] =>
  deltaOf(delta, 'changed').filter(change => change.choice === 'needed').map(change => change.change)

const describeLanding = (content: PlanContent): string =>
  content.landing.mode === 'integration-branch' ? `integration branch ${content.landing.branch}` : content.landing.mode

/** Start's shipped entry by name: Apply reuses it unchanged over a narrowed context. */
function startEntry(name: string): (ctx: StartCheckContext) => string | null {
  const entry = START_PRECONDITIONS.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`Start precondition ${name} is not shipped`)
  return entry.check
}

/** The Start context fields an Apply-reused entry reads; the rest never reach those entries. */
const asStart = (ctx: Partial<StartCheckContext>): StartCheckContext => ctx as StartCheckContext

/** The shipped Apply preconditions, in order (D3). */
export const APPLY_PRECONDITIONS: readonly ApplyPrecondition[] = [
  {
    name: 'plan-open',
    check: ({ plan }) => (plan.lifecycle === 'open' ? null : `The plan is ${plan.lifecycle}; an execution of a closed plan takes no revision.`),
  },
  {
    name: 'execution-running',
    check: ({ execution }) => (execution.state === 'running'
      ? null
      : `The execution ${execution.id} is ${execution.outcome ?? execution.state}; Apply moves only a running execution.`),
  },
  {
    // The compare-and-set (AK4): a concurrent Apply that committed first moved the revision.
    name: 'execution-revision-unchanged',
    check: ({ execution, request }) => (execution.revision === request.expectedRevision
      ? null
      : `The execution now runs revision ${execution.revision}, not ${request.expectedRevision}; reload and apply again.`),
  },
  {
    name: 'revision-current',
    check: ({ plan, target, request }) => {
      if (target === null) return `Revision ${request.revision} does not exist.`
      if (target.contentHash !== request.contentHash) {
        return `Revision ${request.revision}'s content hash is ${target.contentHash}, not ${request.contentHash}: it differs from what was reviewed. Reload and apply again.`
      }
      return plan.currentApprovedRevision === request.revision
        ? null
        : `Revision ${request.revision} is not the plan's approved revision (${plan.currentApprovedRevision ?? 'none'}). Approve it first.`
    },
  },
  {
    name: 'revision-newer',
    check: ({ execution, request }) => (request.revision > execution.revision
      ? null
      : `Revision ${request.revision} is not newer than the execution's revision ${execution.revision}; Apply only moves forward.`),
  },
  { name: 'validation-current', check: ({ validation }) => startEntry('validation-current')(asStart({ validation })) },
  { name: 'start-conditions-resolved', check: ({ validation }) => startEntry('start-conditions-resolved')(asStart({ validation })) },
  { name: 'strategy-impact', check: ({ impactGate }) => startEntry('strategy-impact')(asStart({ impactGate })) },
  {
    name: 'landing-unchanged',
    check: ({ delta, running, target }) => {
      if (!delta?.findings.some(finding => finding.kind === 'landing-changed') || running === null || target === null) return null
      return `The running execution lands with ${describeLanding(running)}; revision ${target.revision} lands with ${describeLanding(target.content)}. A running execution keeps its landing: start a new execution, or add a change that corrects it forward (plan-supervision S4).`
    },
  },
  {
    name: 'landed-unchanged',
    check: ({ delta }) => {
      const messages: string[] = []
      const landed = delta?.findings.find(finding => finding.kind === 'landed-changed')
      if (landed) messages.push(`Landed changes would be removed or redefined: ${landed.changes.join(', ')}. Landed work keeps its evidence; add a change that corrects it (plan-supervision S4).`)
      if (delta?.findings.some(finding => finding.kind === 'plan-rules-changed')) {
        messages.push('The plan-wide acceptance rules or extra checks changed after a change landed; add a change that corrects it (plan-supervision S4).')
      }
      return messages.length === 0 ? null : messages.join(' ')
    },
  },
  {
    name: 'merge-quiet',
    check: ({ liveMerges }) => (liveMerges.length === 0
      ? null
      : `A merge or fast-forward is in flight for ${liveMerges.join(', ')}; wait for it to settle, then apply again.`),
  },
  {
    name: 'choices-complete',
    check: ({ delta, request }) => {
      const needed = neededChoices(delta)
      const failures: string[] = []
      for (const change of needed) {
        const choice = request.choices[change]
        if (choice === undefined) failures.push(`${change} needs a choice: continue, adapt, or restart.`)
        else if (!(APPLY_CHOICES as readonly string[]).includes(choice)) failures.push(`${change}'s choice "${choice}" is not continue, adapt, or restart.`)
      }
      for (const change of Object.keys(request.choices).sort()) {
        if (!needed.includes(change)) failures.push(`${change} takes no choice: it is not a changed change with a task.`)
      }
      for (const [change, text] of Object.entries(request.adaptations ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (request.choices[change] !== 'adapt') failures.push(`${change} has an Adapt text but is not chosen adapt.`)
        else if (text.trim() === '') failures.push(`${change}'s Adapt text is empty; write one or omit it for the generated text.`)
      }
      return failures.length === 0 ? null : failures.join(' ')
    },
  },
  {
    name: 'changes-unclaimed',
    check: ({ claimedChanges }) => startEntry('changes-unclaimed')(asStart({ claimedChanges })),
  },
  {
    name: 'changes-on-base',
    check: ({ baseDiffs }) => startEntry('changes-on-base')(asStart({ baseDiffs })),
  },
  {
    name: 'roles-routable',
    check: ({ roles }) => startEntry('roles-routable')(asStart({ roles })),
  },
]

/** Every entry's standing, in list order: null when it holds. */
export function applyStanding(ctx: ApplyCheckContext): Array<{ name: string; message: string | null }> {
  return APPLY_PRECONDITIONS.map(entry => ({ name: entry.name, message: entry.check(ctx) }))
}

/** The failing entries, in list order (AP16: every failing entry at once). */
export function evaluateApplyPreconditions(ctx: ApplyCheckContext): Array<{ name: string; message: string }> {
  return applyStanding(ctx).flatMap(entry => (entry.message === null ? [] : [{ name: entry.name, message: entry.message }]))
}

/** The change names the changes-on-base comparison reads (D3): added, and changed ones chosen adapt or restart. */
export function baseComparedChanges(delta: RevisionDelta | null, choices: Record<string, string>): string[] {
  return [
    ...deltaOf(delta, 'added').map(change => change.change),
    ...deltaOf(delta, 'changed').filter(change => choices[change.change] === 'adapt' || choices[change.change] === 'restart').map(change => change.change),
  ]
}
