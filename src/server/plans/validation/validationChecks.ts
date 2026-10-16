// The technical checks (plan-validation design D3/D4): `VALIDATION_CHECKS`, a
// constant ordered list like `APPROVAL_PRECONDITIONS`. Each entry names the
// UX row it reports under and returns its findings from a context the file
// and record phases gathered. The rules that shape every check:
// - a missing operation never yields success — an unavailable adapter fails
//   `adapter-available`, and `openspec-valid` and `relations` each report one
//   "not checked" error instead;
// - a change that is not `registered` is skipped by the CLI-reading checks,
//   because its `change-registered` error already blocks;
// - capacity is evidence only and never fails a report.
import type { PlanContent, PlanLifecycle, PlanRevisionStatus, PlanStrategyPin } from '../../../shared/plans'
import { effectiveReviewGroup } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import type { Finding, ValidationCapacityEvidence, ValidationChangeStatus, ValidationEvidence, ValidationRow } from '../../../shared/planValidation'
import { deriveRelations, findingKey, overlapKey, relationFindings, type SpecTouch } from '../../../shared/planValidation'
import type { AdapterProbe, ShowDeltasOutcome, ValidateOutcome } from './openspecAdapter'

/** Where a change resolved (D3): its status, directory, root, and that root's `HEAD`. */
export interface ResolvedChange {
  change: string
  status: ValidationChangeStatus
  /** The change directory itself — the archive directory when archived; null when missing. */
  dir: string | null
  root: string | null
  head: string | null
}

/** Everything a check may read, gathered by the file phase (no transaction) and the record phase (inside one). */
export interface ValidationCheckContext {
  content: PlanContent
  pin: PlanStrategyPin | null
  adapter: AdapterProbe
  /** One entry per plan change, by name. */
  resolved: Readonly<Record<string, ResolvedChange>>
  /** CLI outcomes for the registered changes, from the file phase. */
  cli: Readonly<Record<string, { validate: ValidateOutcome; deltas: ShowDeltasOutcome }>>
  /** The revision's impact gate (C-I1) — for a dry run, the gate of the pin submission would take. */
  gate: ImpactGate
  /** Other open plans' ids claiming this plan's branch and changes (D2). */
  claims: { branch: string[]; changes: Record<string, string[]> }
  /** The team's groups with their declared profiles. */
  groups: ReadonlyMap<string, { profiles: readonly string[] }>
  knownProfiles: ReadonlySet<string>
  capacity: readonly ValidationCapacityEvidence[]
  /** Landing-branch facts (evidence for `branch-free`). */
  branch: ValidationEvidence['branch']
}

export interface ValidationCheck {
  name: string
  row: ValidationRow
  run: (ctx: ValidationCheckContext) => Finding[]
}

const ADAPTER_SUBJECT = 'openspec'
const notChecked = (check: string): Finding => ({
  check, key: findingKey(check, ADAPTER_SUBJECT), severity: 'error', row: 'intent',
  subject: ADAPTER_SUBJECT, message: 'not checked: OpenSpec adapter unavailable',
})

/** Every group the plan names: roles, per-change, and review groups (D3 `groups-known`). */
export function namedGroups(content: PlanContent): string[] {
  const names = new Set<string>()
  for (const role of content.roles) names.add(role.group)
  for (const change of content.changes) {
    if (change.group) names.add(change.group)
    const review = effectiveReviewGroup(content, change)
    if (review) names.add(review)
  }
  if (content.reviewGroup) names.add(content.reviewGroup)
  return [...names]
}

export const VALIDATION_CHECKS: readonly ValidationCheck[] = [
  {
    name: 'adapter-available',
    row: 'readiness',
    run: ({ adapter }) => [adapter.ok
      ? {
          check: 'adapter-available', key: findingKey('adapter-available', ADAPTER_SUBJECT), severity: 'evidence', row: 'readiness',
          subject: ADAPTER_SUBJECT, message: `OpenSpec adapter available (version ${adapter.version}).`,
          detail: { version: adapter.version, capabilities: adapter.capabilities },
        }
      : {
          check: 'adapter-available', key: findingKey('adapter-available', ADAPTER_SUBJECT), severity: 'error', row: 'readiness',
          subject: ADAPTER_SUBJECT, message: `OpenSpec adapter unavailable: ${adapter.error ?? 'unknown error'}`,
          detail: { version: adapter.version, capabilities: adapter.capabilities },
        }],
  },
  {
    name: 'change-registered',
    row: 'scope',
    run: ({ content, resolved }) => content.changes.flatMap((change): Finding[] => {
      const found = resolved[change.change]
      if (!found) return []
      if (found.status === 'registered') {
        return [{
          check: 'change-registered', key: findingKey('change-registered', change.change), severity: 'evidence', row: 'scope',
          subject: change.change, message: `${change.change} resolves in ${found.root}.`,
          detail: { root: found.root, head: found.head },
        }]
      }
      const detail = { root: found.root, dir: found.dir, head: found.head }
      if (found.status === 'archived') {
        return [{
          check: 'change-registered', key: findingKey('change-registered', change.change), severity: 'error', row: 'scope',
          subject: change.change, message: `${change.change} is archived (${found.dir}); unarchive it or rename the plan's change.`,
          detail,
        }]
      }
      if (found.status === 'unregistered') {
        return [{
          check: 'change-registered', key: findingKey('change-registered', change.change), severity: 'error', row: 'scope',
          subject: change.change, message: `${change.change} exists only in ${found.root}, a worktree outside the registry; register it in the main worktree's OpenSpec root.`,
          detail,
        }]
      }
      return [{
        check: 'change-registered', key: findingKey('change-registered', change.change), severity: 'error', row: 'scope',
        subject: change.change, message: `${change.change} is missing: not in the registry, any worktree, or the archive.`,
        detail,
      }]
    }),
  },
  {
    name: 'openspec-valid',
    row: 'intent',
    run: ({ content, resolved, cli, adapter }) => {
      if (!adapter.ok) return [notChecked('openspec-valid')]
      return content.changes.flatMap((change): Finding[] => {
        if (resolved[change.change]?.status !== 'registered') return []
        const outcome = cli[change.change]?.validate
        if (!outcome) {
          return [{ check: 'openspec-valid', key: findingKey('openspec-valid', change.change), severity: 'error', row: 'intent', subject: change.change, message: `strict validation of ${change.change} did not run.` }]
        }
        if (!outcome.ok) {
          return [{ check: 'openspec-valid', key: findingKey('openspec-valid', change.change), severity: 'error', row: 'intent', subject: change.change, message: `strict validation of ${change.change} failed: ${outcome.error}` }]
        }
        if (!outcome.valid) {
          return [{
            check: 'openspec-valid', key: findingKey('openspec-valid', change.change), severity: 'error', row: 'intent', subject: change.change,
            message: `${change.change} fails openspec validate --strict (${outcome.issueCount} issue${outcome.issueCount === 1 ? '' : 's'}).`,
            detail: { issues: outcome.issues, issueCount: outcome.issueCount },
          }]
        }
        return []
      })
    },
  },
  {
    name: 'relations',
    row: 'scope',
    run: (ctx) => {
      if (!ctx.adapter.ok) return [{ ...notChecked('relations'), row: 'scope' as const }]
      const names = ctx.content.changes.map(change => change.change).filter(name => ctx.resolved[name]?.status === 'registered')
      const deltas: Record<string, readonly SpecTouch[]> = {}
      for (const name of names) deltas[name] = ctx.cli[name]?.deltas.touches ?? []
      const dependsOn = Object.fromEntries(ctx.content.changes.map(change => [change.change, change.dependsOn]))
      return relationFindings(deriveRelations(names, deltas, dependsOn))
    },
  },
  {
    name: 'change-claimed-elsewhere',
    row: 'scope',
    run: ({ content, claims }) => content.changes.flatMap((change): Finding[] => {
      const plans = claims.changes[change.change] ?? []
      if (plans.length === 0) return []
      return [{
        check: 'change-claimed-elsewhere', key: findingKey('change-claimed-elsewhere', change.change), severity: 'warning', row: 'scope',
        subject: change.change, message: `${change.change} is also named by open plan${plans.length === 1 ? '' : 's'} ${plans.join(', ')}.`,
        detail: { plans },
      }]
    }),
  },
  {
    name: 'strategy-impact',
    row: 'alignment',
    run: ({ gate }) => gate.pass
      ? [{ check: 'strategy-impact', key: findingKey('strategy-impact', 'gate'), severity: 'evidence', row: 'alignment', subject: 'gate', message: `Strategy impact gate passes (${gate.state}).`, detail: { state: gate.state } }]
      : [{ check: 'strategy-impact', key: findingKey('strategy-impact', 'gate'), severity: 'error', row: 'alignment', subject: 'gate', message: `Strategy impact gate does not pass (${gate.state}).`, detail: { state: gate.state } }],
  },
  {
    name: 'groups-known',
    row: 'readiness',
    run: ({ content, groups }) => namedGroups(content).flatMap((group): Finding[] => {
      if (groups.has(group)) return []
      return [{
        check: 'groups-known', key: findingKey('groups-known', group), severity: 'error', row: 'readiness',
        subject: group, message: `Group ${group} is not in the team's catalog; edit the plan's roles or add the group file.`,
      }]
    }),
  },
  {
    name: 'profiles-known',
    row: 'readiness',
    run: ({ content, groups, knownProfiles }) => content.roles.flatMap((role): Finding[] => {
      const unknown = role.profiles.filter(profile => !knownProfiles.has(profile))
      const findings: Finding[] = unknown.map(profile => ({
        check: 'profiles-known', key: findingKey('profiles-known', `${role.group}/${profile}`), severity: 'error', row: 'readiness',
        subject: profile, message: `Profile ${profile} (role ${role.group}) is not a known profile.`,
      }))
      const declared = groups.get(role.group)?.profiles ?? []
      if (declared.length > 0) {
        for (const profile of role.profiles) {
          // Only a known profile outside the declared set warns; an unknown
          // one already errors above and needs no second finding.
          if (declared.includes(profile) || !knownProfiles.has(profile)) continue
          findings.push({
            check: 'profiles-known', key: findingKey('profiles-known', `${role.group}/${profile}`), severity: 'warning', row: 'readiness',
            subject: profile, message: `Group ${role.group} declares profiles [${declared.join(', ')}]; role profile ${profile} is outside them.`,
          })
        }
      }
      return findings
    }),
  },
  {
    name: 'branch-free',
    row: 'readiness',
    run: ({ content, claims, branch }) => {
      const landing = content.landing
      if (landing.mode !== 'integration-branch') return []
      const findings: Finding[] = claims.branch.map(planId => ({
        check: 'branch-free', key: findingKey('branch-free', landing.branch), severity: 'error', row: 'readiness',
        subject: landing.branch, message: `Another open plan (${planId}) lands on branch ${landing.branch}.`,
        detail: { planId },
      }))
      findings.push({
        check: 'branch-free', key: findingKey('branch-free', `${landing.branch}:state`), severity: 'evidence', row: 'readiness',
        subject: landing.branch, message: `Branch ${landing.branch} ${branch ? `exists at ${branch.head}` : 'was not found'}${branch?.worktree ? ` (checked out in ${branch.worktree})` : ''}.`,
        detail: branch,
      })
      return findings
    },
  },
  {
    name: 'capacity',
    row: 'readiness',
    run: ({ capacity }) => capacity.map(entry => ({
      check: 'capacity', key: findingKey('capacity', entry.group), severity: 'evidence', row: 'readiness',
      subject: entry.group,
      message: `${entry.group}: ${entry.live} live${entry.max === null ? '' : ` of max ${entry.max}`}${entry.profiles.length > 0 ? `; profiles ${entry.profiles.map(profile => `${profile.profile} ${profile.live}${profile.cap === null ? '' : `/${profile.cap}`}`).join(', ')}` : ''}${entry.cooling.length > 0 ? `; cooling: ${entry.cooling.map(cooling => `${cooling.profile} until ${cooling.until}`).join(', ')}` : ''}.`,
      detail: entry,
    })),
  },
]

/** Run every check in order; the findings, in list order (D3). */
export function runValidationChecks(ctx: ValidationCheckContext): Finding[] {
  return VALIDATION_CHECKS.flatMap(check => check.run(ctx))
}

/**
 * Other open plans' claims on this plan's branch and changes (D2): the ids of
 * open plans — never this plan, never closed ones — whose `in_review` or
 * `approved` revisions land on the same integration branch or name one of
 * this plan's changes. The revision's content fixes the rest of the identity,
 * so only the matching claims enter it.
 */
export function computeClaims(
  planId: string,
  others: ReadonlyArray<{ planId: string; lifecycle: PlanLifecycle; revisions: ReadonlyArray<{ status: PlanRevisionStatus; content: PlanContent }> }>,
  branch: string | null,
  changes: readonly string[],
): { branch: string[]; changes: Record<string, string[]> } {
  const branchClaims: string[] = []
  const changeClaims: Record<string, string[]> = {}
  for (const plan of others) {
    if (plan.planId === planId || plan.lifecycle !== 'open') continue
    const standing = plan.revisions.filter(revision => revision.status === 'in_review' || revision.status === 'approved')
    for (const revision of standing) {
      if (branch && revision.content.landing.mode === 'integration-branch' && revision.content.landing.branch === branch && !branchClaims.includes(plan.planId)) {
        branchClaims.push(plan.planId)
      }
      for (const change of revision.content.changes) {
        if (!changes.includes(change.change)) continue
        changeClaims[change.change] = [...(changeClaims[change.change] ?? []), plan.planId].filter((id, index, all) => all.indexOf(id) === index)
      }
    }
  }
  return { branch: branchClaims, changes: changeClaims }
}

/** The overlap warning key for one capability (exported for the walkthrough's accept flow). */
export const overlapWarningKey = overlapKey
