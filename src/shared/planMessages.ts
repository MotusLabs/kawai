// The Plans view's wire messages (durable-plans design D12), unioned into
// ServerMessage and ClientMessage in `types.ts`. Every message names the
// team's directory (`teamPath`), resolved by the shared team-scope resolver;
// replies echo it beside `teamId`. Snapshots and details are authoritative
// and re-sent whole after every committed plan write and every change to a
// task linked to a subscribed plan, so a reconnect needs no deltas. The four
// human commands each carry a command id minted when their dialog opens
// (D7), so a resend replays instead of repeating. Each type has one meaning:
// `team-plan-close` only ends a detail subscription, and completing or
// cancelling a plan is `team-plan-finish`. The `impact` fields
// (strategy-revision-impact D6) are additive and composed beside the plan
// store's reads from the one impact gate, so a badge and a refusal agree.
import type { PlanDetail, PlanEvent, PlanSummary } from './plans'
import type { ImpactGate, PlanImpact } from './strategyImpact'

export type PlanServerMessage =
  | { type: 'team-plans-snapshot'; teamPath: string; teamId: string; plans: PlanSummary[]; impact?: Record<string, PlanImpact> }
  | { type: 'team-plan-detail'; teamPath: string; teamId: string; detail: PlanDetail; impact?: PlanImpact }
  // Result of a human plan command: the plan after it and the recorded event
  // (`replayed` when the command id already stood); `error` on refusal, with
  // the failing preconditions named when approval was refused.
  | {
      type: 'team-plan-result'
      teamPath: string
      requestId: string
      plan?: PlanSummary
      event?: PlanEvent
      replayed?: boolean
      error?: string
      reason?: string
      failures?: Array<{ name: string; message: string }>
      /** The refused revision's impact gate, when `strategy-pin-current` is among the failures. */
      impact?: ImpactGate
    }

export type PlanClientMessage =
  | { type: 'team-plans-open' | 'team-plans-close'; teamPath: string }
  | { type: 'team-plan-open' | 'team-plan-close'; teamPath: string; planId: string }
  | {
      type: 'team-plan-approve'
      teamPath: string
      requestId: string
      planId: string
      revision: number
      /** The content hash the human reviewed. */
      contentHash: string
      /** The approved revision the human saw (null: none). */
      expectedApprovedRevision: number | null
      commandId: string
    }
  | { type: 'team-plan-withdraw'; teamPath: string; requestId: string; planId: string; revision?: number; draftId?: string; commandId: string }
  | { type: 'team-plan-finish'; teamPath: string; requestId: string; planId: string; outcome: 'completed' | 'cancelled'; reason?: string | null; commandId: string }
  | { type: 'team-plan-reopen'; teamPath: string; requestId: string; planId: string; commandId: string }
