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
import type { PromotionPreview } from './planIntegration'
import type { ImpactGate, PlanImpact } from './strategyImpact'
import type { DecisionCard, DecisionPublicationReceipt, PlanDecision, PublicationReview } from './planDecisions'
import type { HoldCites, HoldScope, HoldView, PauseView } from './planRevisionControl'
import type { AlignmentAssessment, AssessmentFinding, PlanRevisionValidation, PlanValidationReport, Question } from './planValidation'

export type PlanServerMessage =
  | { type: 'team-plans-snapshot'; teamPath: string; teamId: string; plans: PlanSummary[]; impact?: Record<string, PlanImpact> }
  // revision-control D14: `holds` and `pauses` ride the detail message
  // beside `impact` and `validation`, read by the one revision-control reader.
  | {
      type: 'team-plan-detail'; teamPath: string; teamId: string; detail: PlanDetail; impact?: PlanImpact; validation?: PlanRevisionValidation[]
      holds?: HoldView[]; pauses?: PauseView[]
    }
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
      /** plan-validation: the outcome of `team-plan-validate`. */
      validation?: { report: PlanValidationRecord; stored: boolean; dryRun: boolean }
      /** plan-validation: new record ids from `team-plan-assess`. */
      assessment?: { ids: { alignment: string | null; questions: string[]; findings: string[] }; replayed: boolean }
      /** plan-execution D17: the outcome of an execution command, with the execution it touched. */
      execution?: { id: string; state: 'running' | 'finished'; outcome: 'completed' | 'stopped' | null }
      /** plan-execution D17: the preview's standing (the failing preconditions with their messages). */
      preview?: { failures: Array<{ name: string; message: string }>; ready: boolean }
      /** integration-candidates D13: the Promote dialog's preview — the standing, the pinned head, what it carries. */
      promotionPreview?: PromotionPreview
      /** integration-candidates D13: the promotion a Promote or Cancel started or finished. */
      promotion?: { id: string; number: number; promotionBranch: string; state: 'running' | 'finished'; outcome: string | null }
      /** plan-supervision D15: the owner's answer or override, with the fix task an override created. */
      decision?: { card: DecisionCard; decision: PlanDecision; fixTaskId?: string | null }
      publicationReview?: PublicationReview
      publication?: DecisionPublicationReceipt
      /** revision-control D14: the hold a place, extend, or release wrote (on a replay, the stored hold the first command wrote). */
      hold?: HoldView
      /** revision-control D4: the changes-scoped hold a narrowing release placed over `retain`. */
      narrowed?: HoldView | null
      /** revision-control D14: the pause `team-plan-pause` opened, as the detail lists it. */
      pause?: PauseView
      /** revision-control D9: the decided target of `team-plan-pause-resolve`, and the hold its releaseHold freed. */
      resolution?: { change: string; decision: string; releaseHold?: { holdId: string; stillCovering: string[] } }
    }

/** The report a `team-plan-result` carries (plan-validation D11): the stored row, or a dry run with a null id. */
export type PlanValidationRecord = PlanValidationReport

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
  // plan-validation D11: the human actions. `team-plan-validate` takes no
  // command id — a repeat with unchanged inputs writes nothing — while the
  // assessment form and every decision carry one, so a resend replays.
  | { type: 'team-plan-validate'; teamPath: string; requestId: string; planId: string; revision: number }
  | { type: 'team-plan-assess'; teamPath: string; requestId: string; planId: string; revision: number; alignment: AlignmentAssessment; commandId: string }
  | { type: 'team-plan-validation-decide'; teamPath: string; requestId: string; planId: string; revision: number; kind: 'answer' | 'accept-warning' | 'resolve-condition' | 'alignment-exception' | 'authorize-exploration'; target: string; text: string; scope?: string | null; commandId: string }
  // plan-execution D17: the human execution commands. Each replays by its
  // command id; `team-plan-result` answers each with `execution` (or
  // `preview` for the standing read).
  | { type: 'team-plan-execution-preview'; teamPath: string; requestId: string; planId: string; revision: number }
  | { type: 'team-plan-execution-start'; teamPath: string; requestId: string; planId: string; revision: number; contentHash: string; commandId: string }
  | { type: 'team-plan-execution-stop'; teamPath: string; requestId: string; executionId: string; reason: string; commandId: string }
  | { type: 'team-plan-execution-retry'; teamPath: string; requestId: string; executionId: string; change: string; commandId: string }
  // integration-candidates D9, D13: the human promotion commands. Promote
  // and Cancel replay by their command id; `team-plan-result` answers with
  // `promotionPreview` or `promotion`, or `error` with the failing entries.
  | { type: 'team-plan-promotion-preview'; teamPath: string; requestId: string; planId: string; branch: string }
  | { type: 'team-plan-promote'; teamPath: string; requestId: string; planId: string; branch: string; fromSha: string; commandId: string }
  | { type: 'team-plan-promotion-cancel'; teamPath: string; requestId: string; promotionId: string; reason: string; commandId: string }
  // plan-supervision D15: the owner answers a card addressed to the owner,
  // or overrides a decided card naming the decision it saw; each replays
  // by its command id, and `team-plan-result` answers with `decision`.
  | { type: 'team-plan-decide'; teamPath: string; requestId: string; planId: string; cardId: string; choice?: string | null; optionIndex?: number | null; rationale?: string | null; commandId: string }
  | { type: 'team-plan-override'; teamPath: string; requestId: string; planId: string; cardId: string; expectedDecisionId: string; choice?: string | null; optionIndex?: number | null; rationale: string; commandId: string }
  | { type: 'team-plan-publication-review'; teamPath: string; requestId: string; planId: string; cardId: string }
  | { type: 'team-plan-approve-publication'; teamPath: string; requestId: string; planId: string; cardId: string; expectedHandoffId: string; expectedBindingHash: string; rationale?: string | null; commandId: string }
  // revision-control D14: the owner's hold and pause commands. Each replays
  // by its command id; `team-plan-result` answers with `hold` (and
  // `narrowed`), `pause`, or `resolution`, or `error` with every failing check.
  | { type: 'team-plan-hold-place'; teamPath: string; requestId: string; planId: string; scope: HoldScope; changes?: string[]; rationale: string; deadline: string; cites?: HoldCites | null; commandId: string }
  | { type: 'team-plan-hold-release'; teamPath: string; requestId: string; planId: string; holdId: string; reason: string; changes?: string[]; retain?: string[]; commandId: string }
  | { type: 'team-plan-hold-extend'; teamPath: string; requestId: string; planId: string; holdId: string; deadline: string; reason?: string; commandId: string }
  | { type: 'team-plan-pause'; teamPath: string; requestId: string; planId: string; holdId: string; deadline: string; note?: string; commandId: string }
  | { type: 'team-plan-pause-resolve'; teamPath: string; requestId: string; planId: string; pauseId: string; change: string; choice: 'continue' | 'adapt' | 'restart'; adapt?: string; rationale?: string; releaseHold?: boolean; commandId: string }

/** plan-validation D11: the shape `team-plan-assess` alignment takes (questions and findings are the agents' tools'). */
export type PlanAssessAlignment = AlignmentAssessment
export type PlanAssessQuestion = Question
export type PlanAssessFinding = AssessmentFinding
