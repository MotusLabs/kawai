// Decision inputs (plan-supervision design D4–D6): the limits of
// `decision_ask` and `decision_record`, the choice an option index or new
// text names, the compared payloads of the owner's commands, and the mail
// bodies of a question and an answer. Pure; `DecisionService` composes them.
import type { DecisionCard, PlanDecision } from '../../../shared/planDecisions'

export const QUESTION_MAX = 2000
export const OPTIONS_MAX = 8
export const OPTION_MAX = 300
export const CONTEXT_MAX = 4000
export const CHOICE_MAX = 2000
export const RATIONALE_MAX = 4000

/** A refusal the tools and connections show as written; nothing was written. */
export class DecisionRefusal extends Error {
  constructor(readonly reason: 'invalid' | 'not-found' | 'forbidden' | 'state' | 'stale' | 'replay-mismatch', message: string) {
    super(message)
    this.name = 'DecisionRefusal'
  }
}

const invalid = (message: string) => new DecisionRefusal('invalid', message)

/** D4's limits: the trimmed question, options, and context. */
export function askInput(input: { question: string; options?: string[]; context?: string | null }): { question: string; options: string[]; context: string | null } {
  const question = (input.question ?? '').trim()
  if (question.length < 1 || question.length > QUESTION_MAX) throw invalid(`A question needs 1–${QUESTION_MAX} characters.`)
  const options = (input.options ?? []).map(option => String(option).trim())
  if (options.length > OPTIONS_MAX) throw invalid(`At most ${OPTIONS_MAX} options.`)
  options.forEach((option, index) => {
    if (option.length < 1 || option.length > OPTION_MAX) throw invalid(`Option ${index + 1} needs 1–${OPTION_MAX} characters.`)
  })
  const context = input.context?.trim() ? input.context.trim() : null
  if (context !== null && context.length > CONTEXT_MAX) throw invalid(`Context is at most ${CONTEXT_MAX} characters.`)
  return { question, options, context }
}

/** D5: a 1-based option index naming the option's text, or new choice text; never both. */
export function resolveChoice(options: readonly string[], input: { choice?: string | null; option_index?: number | null }): { choice: string; optionIndex: number | null } {
  const text = input.choice?.trim() ?? ''
  const index = input.option_index ?? null
  if (index !== null && text) throw invalid('Give option_index or choice, not both.')
  if (index !== null) {
    if (!Number.isInteger(index) || index < 1 || index > options.length) {
      throw invalid(options.length ? `option_index must be 1–${options.length}.` : 'This card has no options; give the choice as text.')
    }
    return { choice: options[index - 1]!, optionIndex: index }
  }
  if (text.length < 1 || text.length > CHOICE_MAX) throw invalid(`A choice needs option_index or 1–${CHOICE_MAX} characters of text.`)
  return { choice: text, optionIndex: null }
}

/** D5: a required rationale of 1–4000 characters (D6: optional for the owner's answer). */
export function rationaleOf(value: string | null | undefined, required: boolean): string | null {
  const text = value?.trim() ?? ''
  if (!text) {
    if (required) throw invalid('A decision needs a rationale: say why this choice.')
    return null
  }
  if (text.length > RATIONALE_MAX) throw invalid(`A rationale is at most ${RATIONALE_MAX} characters.`)
  return text
}

/** The first field of `fields` whose value differs between the stored and the replayed payload. */
export function payloadDiff(stored: Record<string, unknown> | null, replayed: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    if (JSON.stringify(stored?.[field] ?? null) !== JSON.stringify(replayed[field] ?? null)) return field
  }
  return null
}

/** Who decided, for refusals and bodies. */
export function deciderName(decision: PlanDecision): string {
  if (decision.decidedBy.kind === 'human') return 'the owner'
  const group = decision.decidedBy.group ? ` (${decision.decidedBy.group})` : ''
  return `${decision.decidedBy.session ?? 'an agent'}${group}`
}

/** D4: the Lead's question mail. */
export function questionBody(card: DecisionCard, planTitle: string): string {
  const where = [`plan "${planTitle}" (${card.planId})`, card.change ? `change ${card.change}` : null, card.taskId ? `task ${card.taskId}` : null]
    .filter(Boolean).join(', ')
  const lines = [
    `Decision card ${card.id} on ${where}, asked by ${card.askedBy.session}${card.askedBy.group ? ` (${card.askedBy.group})` : ''}:`,
    '',
    card.question,
  ]
  if (card.options.length) lines.push('', 'Options:', ...card.options.map((option, index) => `${index + 1}. ${option}`))
  if (card.context) lines.push('', `Context: ${card.context}`)
  lines.push('', `Decide it with decision_record({ plan_id: "${card.planId}", card_id: "${card.id}", option_index or choice, rationale }) — a reply to this message is refused while the card is open.`)
  return lines.join('\n')
}

/** D5/D6: the answer mail. */
export function answerBody(card: DecisionCard, decision: PlanDecision): string {
  const lines = [`Decision on card ${card.id} by ${deciderName(decision)}: ${decision.choice}`]
  if (decision.rationale) lines.push('', `Rationale: ${decision.rationale}`)
  lines.push('', `Question: ${card.question}`)
  return lines.join('\n')
}
