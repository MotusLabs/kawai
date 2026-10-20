// Plan content checks (durable-plans design D3). Structure is checked on
// every save and completeness on submission; both return every violation,
// never only the first. Environment facts — whether a named OpenSpec change,
// group, or profile exists, or a branch is free — are deliberately absent:
// they belong to plan validation, because a plan legitimately names changes
// still being proposed. plan-supervision D2 adds the Lead role and `fixes`
// format checks; whether a `fixes` id names a fix task is a read-time warning.
// Pure and SDK-free, shared by server and client.
import type { StrategyContent } from './productStrategy'
import type { PlanCheck, PlanContent } from './plans'
import { PLAN_CHECK_FLOOR, effectiveReviewGroup } from './plans'
import { fixesFieldErrors } from './planDecisions'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BRANCH = /^[A-Za-z0-9._/-]+$/

/** Whether a change or check name is kebab-case. */
export const isKebabName = (value: string): boolean => KEBAB.test(value)

/** Why an integration branch name is malformed, or null when it is acceptable. */
export function branchNameError(branch: string): string | null {
  if (!branch) return 'Integration-branch landing needs a branch name.'
  const bad = !BRANCH.test(branch) || branch.includes('..') || branch.startsWith('-') || branch.startsWith('/')
    || branch.endsWith('/') || branch.endsWith('.lock')
  return bad ? `Integration branch "${branch}" is malformed: use letters, digits, ".", "_", "/", "-", with no "..", no leading "-" or "/", and no trailing "/" or ".lock".` : null
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

function checkErrors(checks: PlanCheck[], scope: string, reserved: ReadonlySet<string>, reservedLabel: string): string[] {
  const errors: string[] = []
  for (const check of checks) {
    if (!isKebabName(check.name)) {
      errors.push(`${scope} check "${check.name}" has a malformed name; use kebab-case (e.g. "browser-walkthrough").`)
    } else if ((PLAN_CHECK_FLOOR as readonly string[]).includes(check.name)) {
      errors.push(`${scope} check "${check.name}" reuses a reserved floor check name; the floor (${PLAN_CHECK_FLOOR.join(', ')}) always applies and cannot be redefined.`)
    } else if (reserved.has(check.name)) {
      errors.push(`${scope} check "${check.name}" repeats ${reservedLabel}.`)
    }
  }
  for (const name of duplicates(checks.map(check => check.name))) {
    errors.push(`${scope} check "${name}" is listed more than once.`)
  }
  return errors
}

/**
 * Every dependency cycle as its path (`a → b → a`), found by depth-first
 * search with an explicit stack. Each cycle is reported once, starting at
 * the first change on it in plan order.
 */
export function dependencyCycles(content: PlanContent): string[][] {
  const edges = new Map(content.changes.map(change => [change.change, change.dependsOn.filter(dep => dep !== change.change)]))
  const order = content.changes.map(change => change.change)
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: string[][] = []
  const seen = new Set<string>()
  for (const root of order) {
    if (state.has(root)) continue
    const path: string[] = []
    const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }]
    state.set(root, 'visiting')
    path.push(root)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const deps = edges.get(frame.node) ?? []
      if (frame.next >= deps.length) {
        state.set(frame.node, 'done')
        stack.pop()
        path.pop()
        continue
      }
      const dep = deps[frame.next++]!
      if (!edges.has(dep)) continue
      const mark = state.get(dep)
      if (mark === 'visiting') {
        const cycle = path.slice(path.indexOf(dep))
        // Rotate to the change listed first in the plan, so one cycle has one key.
        const start = cycle.reduce((best, node) => (order.indexOf(node) < order.indexOf(best) ? node : best), cycle[0]!)
        const rotated = [...cycle.slice(cycle.indexOf(start)), ...cycle.slice(0, cycle.indexOf(start))]
        const key = rotated.join('\0')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push([...rotated, start])
        }
      } else if (mark === undefined) {
        state.set(dep, 'visiting')
        path.push(dep)
        stack.push({ node: dep, next: 0 })
      }
    }
  }
  return cycles
}

/** D3 structure: every violation a save refuses. Incomplete content passes. */
export function planStructureErrors(content: PlanContent): string[] {
  const errors: string[] = []
  const names = content.changes.map(change => change.change)
  for (const change of content.changes) {
    if (!isKebabName(change.change)) {
      errors.push(`Change "${change.change}" is not a kebab-case OpenSpec change name.`)
    }
  }
  for (const name of duplicates(names)) errors.push(`Change "${name}" is listed more than once.`)
  const known = new Set(names)
  for (const change of content.changes) {
    for (const dep of change.dependsOn) {
      if (dep === change.change) errors.push(`Change "${change.change}" depends on itself.`)
      else if (!known.has(dep)) errors.push(`Change "${change.change}" depends on "${dep}", which is unknown: the plan lists no change "${dep}".`)
    }
    for (const dep of duplicates(change.dependsOn)) errors.push(`Change "${change.change}" lists dependency "${dep}" more than once.`)
  }
  for (const cycle of dependencyCycles(content)) errors.push(`Dependency cycle: ${cycle.join(' → ')}.`)

  const planChecks = new Set(content.extraChecks.map(check => check.name))
  errors.push(...checkErrors(content.extraChecks, 'Plan-wide', new Set(), ''))
  for (const change of content.changes) {
    errors.push(...checkErrors(change.extraChecks, `Change "${change.change}"`, planChecks, 'a plan-wide check name'))
  }

  if (content.landing.mode === 'integration-branch') {
    const error = branchNameError(content.landing.branch)
    if (error) errors.push(error)
  }

  const roles = content.roles.map(role => role.group)
  for (const role of content.roles) {
    if (!role.group) errors.push('A role names no group.')
    for (const profile of duplicates(role.profiles)) errors.push(`Role "${role.group}" lists profile "${profile}" more than once.`)
  }
  for (const group of duplicates(roles)) errors.push(`Role "${group}" is listed more than once.`)
  const roleSet = new Set(roles)
  const missing = (group: string | null, where: string) => {
    if (group && !roleSet.has(group)) errors.push(`${where} names group "${group}", which is missing from the roles; add it to the roles or pick a listed group.`)
  }
  missing(content.reviewGroup, 'The plan review group')
  // plan-supervision D2: the Lead role is one of the roles; `fixes` entries are
  // task ids, unique within a change (one task may span several changes).
  missing(content.leadGroup ?? null, 'The plan Lead role')
  for (const change of content.changes) errors.push(...fixesFieldErrors(change.change, change.fixes))
  for (const change of content.changes) {
    missing(change.group, `Change "${change.change}" (implementing group)`)
    missing(change.reviewGroup, `Change "${change.change}" (review group)`)
  }
  for (const ref of duplicates(content.alignment.refs)) errors.push(`Alignment reference "${ref}" is listed more than once.`)
  return errors
}

/** D3 completeness, beyond structure: every gap a submission refuses. */
export function planSubmitErrors(content: PlanContent): string[] {
  const errors: string[] = []
  if (!content.goal.trim()) errors.push('The plan needs a goal.')
  if (content.successCriteria.length === 0) errors.push('The plan needs at least one success criterion.')
  if (content.changes.length === 0) errors.push('The plan needs at least one change.')
  for (const change of content.changes) {
    if (!change.group) errors.push(`Change "${change.change}" needs an implementing group.`)
    if (!effectiveReviewGroup(content, change)) errors.push(`Change "${change.change}" needs a review group (its own, or the plan's).`)
  }
  return errors
}

/**
 * The refs a strategy revision defines for alignment (D6 step 4): use cases,
 * principles, success measures, and decisions. Claims are evidence, not
 * direction, and needs/outcomes are prose — neither can be cited.
 */
export function strategyAlignmentRefs(content: StrategyContent): Set<string> {
  return new Set([
    ...content.useCases.map(entry => entry.ref),
    ...content.principles.map(entry => entry.ref),
    ...content.successMeasures.map(entry => entry.ref),
    ...content.decisions.map(entry => entry.ref),
  ])
}
