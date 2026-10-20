// Decision tools on the per-session `kawai-team` MCP server
// (plan-supervision design D16). The registered surface is EXACTLY the two
// tools below — ask and record. None answers as the owner, overrides,
// retries, stops, or dismisses: those are the owner's, from the Plans view,
// and no handler for them may be added. Handlers bind the calling session
// id and strip unknown arguments; rights are checked by `DecisionService` at
// each call (D4, D5), and a refusal reaches the agent as its message.
import { z } from 'zod'
import type { DecisionService } from './DecisionService'

export const DECISION_TOOL_NAMES = ['decision_ask', 'decision_record'] as const

/** Every name an agent might reach for that must NOT exist (D16). */
export const DECISION_FORBIDDEN_TOOL_NAMES = [
  'decision_answer', 'decision_override', 'decision_dismiss', 'plan_decide', 'plan_override', 'plan_retry', 'plan_stop', 'execution_retry', 'execution_stop',
] as const

export const decisionSchemas = {
  decision_ask: z.object({
    question: z.string(),
    options: z.array(z.string()).optional(),
    context: z.string().optional(),
    plan_id: z.string().optional(),
  }),
  decision_record: z.object({
    plan_id: z.string().min(1),
    card_id: z.string().optional(),
    question: z.string().optional(),
    options: z.array(z.string()).optional(),
    choice: z.string().optional(),
    option_index: z.number().int().optional(),
    rationale: z.string(),
    affected_tasks: z.array(z.string()).optional(),
  }),
}

export const decisionDescriptions: Record<(typeof DECISION_TOOL_NAMES)[number], string> = {
  decision_ask: 'Ask a decision on plan work instead of guessing or asking the human in prose. The plan comes from your session: your plan task, your fix task, or — in the plan\'s Lead role — plan_id. question 1–2000 characters, up to 8 options (1–300 each), context up to 4000. Addressed to the Lead role when the plan has one and you are outside it (it gets the question as mail), else to the owner. The answer arrives as mail in the question\'s thread; continue other work or end your turn meanwhile.',
  decision_record: 'Record a decision on a plan (Lead role). With card_id: answer a card addressed to your group — option_index (1-based) or a new choice text, and a rationale; the answer reaches the asker. A reply to the question is refused while the card is open, so decide it here. Without card_id: record your own call — question, choice, rationale. affected_tasks defaults to the card\'s task. First decision wins; only the owner overrides it.',
}

export function decisionHandlers(decisions: DecisionService, sessionId: string) {
  // Identity is bound here, never taken from arguments (D16).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    decision_ask: async (input: unknown) => {
      const parsed = decisionSchemas.decision_ask.parse(input)
      const { card, guidance } = await decisions.ask(caller, parsed)
      return { card_id: card.id, addressed_to: card.addressedTo, ...(card.addressedGroup ? { addressed_group: card.addressedGroup } : {}), guidance }
    },
    decision_record: async (input: unknown) => {
      const parsed = decisionSchemas.decision_record.parse(input)
      const outcome = await decisions.record(caller, parsed)
      return {
        decision_id: outcome.decision.id, card_id: outcome.card.id, kind: outcome.decision.kind, choice: outcome.decision.choice,
        replayed: outcome.replayed, ...(outcome.message ? { message_id: outcome.message.id } : {}),
      }
    },
  }
}
