// Answer validation for the question cards an adapter owns itself (Codex
// 0.163.0's async agentMessage questions), unchanged from codexRequests.ts:
// per question, in order, the chosen label (at most one, an offered one)
// plus any typed answer.
import type { ChatQuestion, ChatQuestionAnswer } from '../../../shared/chat'

export function validateAsyncAnswers(
  questions: ChatQuestion[],
  answers: Record<string, ChatQuestionAnswer>,
): { ok: true; answers: string[][] } | { ok: false; error: string } {
  const result: string[][] = []
  for (const question of questions) {
    const answer = answers[question.question]
    const text = answer?.text?.trim()
    const options = answer?.options ?? []
    if (!answer || (options.length === 0 && !text)) return { ok: false, error: `Missing answer for "${question.question}"` }
    if (options.length > 1) return { ok: false, error: `"${question.question}" accepts only one choice` }
    const labels = new Set(question.options.map((option) => option.label))
    for (const label of options) {
      if (!labels.has(label)) return { ok: false, error: `"${label}" is not an offered choice for "${question.question}"` }
    }
    result.push([...options, ...(text ? [text] : [])])
  }
  return { ok: true, answers: result }
}
