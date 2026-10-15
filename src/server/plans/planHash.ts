// Plan content hashing (durable-plans design D2). Server-side only, like
// strategy hashing: the client displays hashes the server sent and never
// computes one. The canonical inputs come from the shared module.
import { createHash } from 'node:crypto'
import type { PlanContent, PlanStrategyPin } from '../../shared/plans'
import { planDraftHashInput, planRevisionHashInput } from '../../shared/plans'

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex')

/** A draft's hash: canonical content only. */
export function hashPlanDraft(content: PlanContent): string {
  return sha256(planDraftHashInput(content))
}

/** A revision's hash: canonical `{content, pin}`, so an approved hash binds the strategy pin. */
export function hashPlanRevision(content: PlanContent, pin: PlanStrategyPin | null): string {
  return sha256(planRevisionHashInput(content, pin))
}
