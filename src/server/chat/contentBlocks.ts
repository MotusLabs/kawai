// Claude conversation content-block shapes, shared by the live SDK stream
// (ChatSessionDriver) and transcript replay (transcriptReplay). SDK-specific
// types stay out of here: these helpers only read the JSON shapes the CLI
// writes to transcripts and the SDK streams as messages.
import type { ChatQuestion, ChatQuestionAnswer } from '../../shared/chat'

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'
export { ASK_USER_QUESTION_TOOL }

// Bounded recommendation grammar (informal-question-recommendations D1). Match only
// explicit annotations, never arbitrary occurrences of "recommend" in prose.
const RECOMMENDATION_PHRASE = '(?:recommended|i recom{1,2}end this|my recommendation)'
const WHOLE_RECOMMENDATION = new RegExp(String.raw`^[\p{P} ]*${RECOMMENDATION_PHRASE}[\p{P} ]*$`, 'u')
const LEADING_RECOMMENDATION = new RegExp(String.raw`^[\p{P} ]*${RECOMMENDATION_PHRASE}[\p{Pe}\p{Pf}"' ]*[.!?:;,–—-] *\S`, 'u')
const TRAILING_RECOMMENDATION = new RegExp(String.raw`(?:[(\[] *${RECOMMENDATION_PHRASE} *[)\]]|[–—:-] *[\p{P} ]*${RECOMMENDATION_PHRASE})[\p{P} ]*$`, 'u')
const NEGATED_RECOMMENDATION = /\b(?:(?:not|never) (?:recommended|my recommendation)|i (?:do not|don['’]t|never|would not|wouldn['’]t|cannot|can['’]t) recom{1,2}end this)\b/

function recommendationText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
    : ''
}

function hasRecommendation(text: string): boolean {
  return WHOLE_RECOMMENDATION.test(text) ||
    LEADING_RECOMMENDATION.test(text) ||
    TRAILING_RECOMMENDATION.test(text)
}

function negatesRecommendation(text: string): boolean {
  // Wrapping a negative marker in brackets does not turn it positive:
  // "Not (Recommended)" must veto the trailing annotation too.
  return NEGATED_RECOMMENDATION.test(text.replace(/[()[\]]/g, ' ').replace(/ +/g, ' '))
}

function isRecommended(option: ChatQuestion['options'][number]): boolean {
  const label = recommendationText(option.label)
  const description = recommendationText(option.description)
  // A disclaimer wins over a positive annotation in either field.
  return !negatesRecommendation(label) &&
    !negatesRecommendation(description) &&
    (hasRecommendation(label) || hasRecommendation(description))
}

/** Flatten a tool_result content value into display text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text?: string }).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/** Parse AskUserQuestion input into structured questions, or null. */
export function parseQuestions(
  input: Record<string, unknown>
): ChatQuestion[] | null {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: ChatQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    const q = entry as {
      question?: unknown
      header?: unknown
      multiSelect?: unknown
      options?: unknown
    }
    if (typeof q.question !== 'string' || typeof q.header !== 'string') return null
    if (!Array.isArray(q.options)) return null
    const options = q.options
      .filter(
        (option): option is { label: string; description?: string; preview?: string } =>
          !!option &&
          typeof option === 'object' &&
          typeof (option as { label?: unknown }).label === 'string'
      )
      .map((option) => ({
        label: option.label,
        ...(option.description !== undefined
          ? { description: option.description }
          : {}),
        ...(option.preview !== undefined ? { preview: option.preview } : {}),
      }))
    if (options.length === 0) return null
    questions.push({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect === true,
      options,
    })
  }
  return questions
}

/**
 * The recommended answers of a parsed AskUserQuestion request, or null when
 * any question lacks one (informal-question-recommendations D1): a deadline exists only
 * when every question marks an option in its label or description using the
 * bounded grammar above. Single-select takes the first match, multi-select
 * every match; labels are returned verbatim so
 * `validateAnswers` accepts them.
 */
export function recommendedAnswers(
  questions: ChatQuestion[]
): Record<string, ChatQuestionAnswer> | null {
  const answers: Record<string, ChatQuestionAnswer> = {}
  for (const question of questions) {
    const recommended = question.options
      .filter(isRecommended)
      .map((option) => option.label)
    if (recommended.length === 0) return null
    answers[question.question] = question.multiSelect
      ? { options: recommended }
      : { options: [recommended[0]!] }
  }
  return answers
}
