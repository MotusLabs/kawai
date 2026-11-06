// Question answer validation, moved from Kawai ChatSessionDriver (agent-runtime
// task 4.1); behavior unchanged. Answers are keyed by question text, must
// name offered labels, and single-select questions take exactly one choice.
import type { AgentQuestion as ChatQuestion, QuestionAnswer as ChatQuestionAnswer } from '../events.js'

export function validateAnswers(
  questions: ChatQuestion[],
  answers: Record<string, ChatQuestionAnswer>
):
  | { ok: true; answers: Record<string, string>; response?: string }
  | { ok: false; error: string } {
  const result: Record<string, string> = {}
  let response: string | undefined
  for (const question of questions) {
    const answer = answers[question.question]
    if (!answer || (!answer.options?.length && !answer.text?.trim())) {
      return { ok: false, error: `Missing answer for "${question.question}"` }
    }
    const labels = new Set(question.options.map((option) => option.label))
    const text = answer.text?.trim()
    if (answer.options?.length) {
      // A single-select answer is one choice: an option or the user's own
      // text. Refuse both rather than silently dropping the text.
      if (!question.multiSelect && text) {
        return {
          ok: false,
          error: `"${question.question}" takes one answer: choose an option or type your own, not both`,
        }
      }
      if (!question.multiSelect && answer.options.length > 1) {
        return {
          ok: false,
          error: `"${question.question}" accepts only one choice`,
        }
      }
      for (const label of answer.options) {
        if (!labels.has(label)) {
          return {
            ok: false,
            error: `"${label}" is not an offered choice for "${question.question}"`,
          }
        }
      }
      // Multi-select: the user's own text is one more selection.
      result[question.question] = [...answer.options, ...(text ? [text] : [])].join(', ')
      if (text) response = text
    } else if (text) {
      result[question.question] = text
      response = text
    }
  }
  return {
    ok: true,
    answers: result,
    ...(response !== undefined ? { response } : {}),
  }
}
