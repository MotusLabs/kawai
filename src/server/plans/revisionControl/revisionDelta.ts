// The revision delta (revision-control design D10): the pure
// `revisionDelta(from, to, landed, provisioned)` classifying every change of
// an execution's revision against the plan's newer approved one, with the
// execution-wide findings Apply refuses on (D11). The compared C1 fields are
// `dependsOn`, `fixes` (plan-supervision D2), the implementing and effective
// review groups, `acceptance`, extra checks, and `guidance`. A landed change
// differing only in `dependsOn` or `fixes` is `metadata` — Apply updates it
// and offers no choice, so a forward fix can name a task on a change that
// already landed; a landed change differing in anything else, or removed,
// is the `landed-changed` refusal. `lead-changed` is informational, never a
// refusal (D10): Apply takes it, and later cards go to the new lead group.
import type { PlanChange, PlanContent } from '../../../shared/plans'
import type { DeltaChange, DeltaFinding, RevisionDelta } from '../../../shared/planRevisionControl'

/** The fields a landed change may differ in and still apply as `metadata`. */
const METADATA_FIELDS: ReadonlySet<string> = new Set(['dependsOn', 'fixes'])

/** A change's effective review group: its own, else the plan's. */
function effectiveReviewGroup(content: PlanContent, change: PlanChange): string | null {
  return change.reviewGroup ?? content.reviewGroup
}

/** The compared fields that differ between two revisions' copies of one change, in field order. */
function changedFields(from: PlanContent, to: PlanContent, a: PlanChange, b: PlanChange): string[] {
  const fields: string[] = []
  // Order is scheduling: a dependency reorder is a real change.
  if (JSON.stringify(a.dependsOn) !== JSON.stringify(b.dependsOn)) fields.push('dependsOn')
  // A fix list's order carries nothing; a missing list reads as empty.
  if (JSON.stringify([...(a.fixes ?? [])].sort()) !== JSON.stringify([...(b.fixes ?? [])].sort())) fields.push('fixes')
  if ((a.group ?? null) !== (b.group ?? null)) fields.push('group')
  if (effectiveReviewGroup(from, a) !== effectiveReviewGroup(to, b)) fields.push('reviewGroup')
  if (JSON.stringify(a.acceptance) !== JSON.stringify(b.acceptance)) fields.push('acceptance')
  if (JSON.stringify(a.extraChecks) !== JSON.stringify(b.extraChecks)) fields.push('extraChecks')
  if (a.guidance !== b.guidance) fields.push('guidance')
  return fields
}

/**
 * Classify every change of `from` and `to` (by name) and collect the
 * execution-wide findings, in D10's order: `landing-changed`,
 * `plan-rules-changed` (only once something has landed), `landed-changed`
 * (a landed change differing beyond `dependsOn`/`fixes`, or removed), and
 * the informational `lead-changed`. The changes read in the target's content
 * order, removed ones last. A `changed` change that is provisioned — it has
 * a task — needs an owner choice (`needed`); one still waiting, with no
 * task, is recorded with choice `none` and picks up the new definition when
 * provisioned.
 */
export function revisionDelta(from: PlanContent, to: PlanContent, landed: ReadonlySet<string>, provisioned: ReadonlySet<string>): RevisionDelta {
  const findings: DeltaFinding[] = []
  const landingChanged = from.landing.mode !== to.landing.mode ||
    (from.landing.mode === 'integration-branch' && to.landing.mode === 'integration-branch' && from.landing.branch !== to.landing.branch)
  if (landingChanged) {
    findings.push({
      kind: 'landing-changed',
      detail: 'The landing mode or integration branch changed; a running execution keeps its landing (D11).',
      changes: [],
    })
  }
  if (JSON.stringify(from.acceptanceRules) !== JSON.stringify(to.acceptanceRules) || JSON.stringify(from.extraChecks) !== JSON.stringify(to.extraChecks)) {
    if (landed.size > 0) {
      findings.push({
        kind: 'plan-rules-changed',
        detail: 'The plan-wide acceptance rules or extra checks changed with landed work; add a change that corrects it (plan-supervision S4).',
        changes: [],
      })
    }
  }

  const fromByName = new Map(from.changes.map(change => [change.change, change]))
  const toByName = new Map(to.changes.map(change => [change.change, change]))
  const landedChanged: string[] = []
  const changes: DeltaChange[] = to.changes.map(toChange => {
    const fromChange = fromByName.get(toChange.change)
    if (!fromChange) return { change: toChange.change, class: 'added', fields: [], choice: null }
    const fields = changedFields(from, to, fromChange, toChange)
    if (fields.length === 0) return { change: toChange.change, class: 'unchanged', fields: [], choice: null }
    if (landed.has(toChange.change)) {
      if (fields.every(field => METADATA_FIELDS.has(field))) {
        return { change: toChange.change, class: 'metadata', fields, choice: null }
      }
      landedChanged.push(toChange.change)
    }
    return {
      change: toChange.change,
      class: 'changed',
      fields,
      choice: provisioned.has(toChange.change) ? 'needed' : 'none',
    }
  })
  for (const name of fromByName.keys()) {
    if (toByName.has(name)) continue
    if (landed.has(name)) landedChanged.push(name)
    changes.push({ change: name, class: 'removed', fields: [], choice: null })
  }
  if (landedChanged.length > 0) {
    findings.push({
      kind: 'landed-changed',
      detail: 'Landed work keeps its evidence; add a change that corrects it (plan-supervision S4).',
      changes: [...landedChanged].sort(),
    })
  }
  if ((from.leadGroup ?? null) !== (to.leadGroup ?? null)) {
    findings.push({
      kind: 'lead-changed',
      detail: 'The Lead role changed; Apply takes it, and cards raised afterwards go to the new lead group.',
      changes: [],
    })
  }
  return { changes, findings }
}
