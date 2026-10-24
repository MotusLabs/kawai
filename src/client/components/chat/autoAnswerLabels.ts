// Pure label rendering for the question auto-answer surfaces
// (question-auto-answer D6): what a standing deadline will choose, what a
// timeout answer chose, and the countdown's m:ss. No React, no clock — the
// caller supplies `now`.

import type { ChatQuestionAutoAnswer } from '@shared/chat'

/**
 * The option labels a standing deadline will submit ("Go (Recommended)", or
 * "Blue, Green" for a multi-select), one question's choice per "; " group.
 */
export function autoAnswerChoiceLabels(answers: ChatQuestionAutoAnswer['answers']): string {
  return Object.values(answers)
    .map(answer => (answer.options ?? []).join(', '))
    .filter(labels => labels.length > 0)
    .join('; ')
}

/** The labels a timeout answer chose, one question's choice per "; " group. */
export function timeoutAnswerLabels(answers: Record<string, string>): string {
  return Object.values(answers).join('; ')
}

/**
 * Time left until the ISO deadline as m:ss on the client clock, ceiled so a
 * live second never reads 0:00; a passed or unreadable deadline reads 0:00
 * (a skewed client may show it briefly before the resolution arrives).
 */
export function formatCountdown(at: string, now: number): string {
  const remaining = new Date(at).getTime() - now
  const seconds = Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
