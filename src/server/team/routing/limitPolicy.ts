// What happens to work whose turn failed on a provider limit (profile-routing
// spec "Limit failures on claimed messages are resolved"). Pure: the rule's
// `onLimit` answer (when it gave one) wins over the group's `onLimit`
// frontmatter, which defaults to: park when the agent made progress and the
// reset is within `parkIfResetWithin` (3h), `otherwise` (forward) when it made
// progress and the reset is later, release when it made none. A message
// already parked three times is released whatever anyone says.
import type { LimitOutcome } from '../../../shared/routing'
import type { GroupLimitPolicy } from '../groupFile'

export const MAX_PARKS = 3

export type LimitResolution =
  | { type: 'park' }
  | { type: 'release' }
  | { type: 'forward'; to: { kind: 'group' | 'session'; id: string } | null }

export interface LimitPolicyInput {
  toolCalls: number
  /** Milliseconds until the provider resets (built-in cooldown when unknown). */
  resetInMs: number
  parkCount: number
  policy: GroupLimitPolicy
  /** The rule's answer; absent when the group has no `onLimit` rule or it failed. */
  ruled?: LimitOutcome
}

export function resolveLimit(input: LimitPolicyInput): LimitResolution {
  if (input.parkCount >= MAX_PARKS) return { type: 'release' }
  const ruled = input.ruled
  if (ruled && ruled.type !== 'default') {
    if (ruled.type === 'forward') return { type: 'forward', to: ruled.to ?? null }
    return { type: ruled.type }
  }
  if (input.toolCalls === 0) return { type: 'release' }
  if (input.resetInMs <= input.policy.parkIfResetWithinMs) return { type: 'park' }
  return input.policy.otherwise === 'release' ? { type: 'release' } : { type: 'forward', to: null }
}
