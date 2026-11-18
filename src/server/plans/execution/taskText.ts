// The text of the task Kawai creates for a change (plan-execution D7): its
// direction points at the OpenSpec change and carries the change's
// guidance; its acceptance is the change's acceptance followed by the
// plan-wide rules. Apply's generated Adapt text (plan-revision-apply D5)
// is the same text over the target revision, so an adapted task reads as if
// it had been created under it.
import type { PlanChange, PlanContent } from '../../../shared/plans'

export function implementTaskText(entry: PlanChange, content: PlanContent): { direction: string; acceptance: string | null } {
  return {
    direction: `The OpenSpec change "${entry.change}" is the authoritative direction for this task; its proposal, design, and tasks under openspec/changes/${entry.change}/ govern the work.\n\n${entry.guidance}`.trim(),
    acceptance: [...entry.acceptance, ...content.acceptanceRules].join('\n') || null,
  }
}
