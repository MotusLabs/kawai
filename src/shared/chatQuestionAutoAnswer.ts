// Recommended-option auto answer contracts (openspec question-auto-answer):
// the deadline payload carried by a pending question, the timeout decision
// marker, the labels an automatic answer chose, and the hold event. Defined
// beside `chat.ts` (design D7), which re-exports them for existing importers.

import type { ChatEventBase, ChatQuestionAnswer } from './chat'

/**
 * The auto-answer deadline of one pending question request, carried by the
 * `question_request` event and the pending-question snapshot only while the
 * deadline stands (a hold drops it; `getPendingRequests` agrees).
 */
export interface ChatQuestionAutoAnswer {
  /** ISO instant at which the server will answer the request. */
  at: string
  /** The answers the server will submit, keyed by question text. */
  answers: Record<string, ChatQuestionAnswer>
}

/**
 * A request settled by its auto-answer deadline, in addition to the user and
 * the approval policy.
 */
export type ChatRequestDecidedByTimeout = 'timeout'

/** The option labels an automatic answer chose, keyed by question text. */
export type ChatRequestTimeoutAnswers = Record<string, string>

/**
 * A request's deadline was removed (Wait for me, or the form's first edit):
 * the request waits for the user and is never answered automatically. Live
 * and replayed like every sequenced event.
 */
export type ChatQuestionAutoAnswerHeldEvent = ChatEventBase & {
  type: 'question_auto_answer_held'
  requestId: string
}
