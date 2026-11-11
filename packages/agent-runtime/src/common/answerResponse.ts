// AnswerOptions.response (task-7811b455 R5; design §2's fifth exception). A
// Claude question takes the caller's non-blank string unchanged as its native
// response, after the typed answers validated. Everywhere else (Codex
// questions, approvals on either runtime) a supplied response is unsupported
// and refused as invalid, so it can never be silently dropped or reread as a
// denial message. Omitted (undefined) changes nothing.
import type { AnswerOptions, AnswerOutcome } from '../contract.js'

type Refusal = Extract<AnswerOutcome, { ok: false }>

/** The refusal for a response where none is supported, or null when none was supplied. */
export function unsupportedResponse(options: AnswerOptions, where: string): Refusal | null {
  if (options.response === undefined) return null
  return { ok: false, reason: 'invalid', message: `A response is not supported on ${where}` }
}

/** A Claude question's explicit response: absent, the string to send, or a refusal. */
export function questionResponse(options: AnswerOptions): { response: string | undefined } | Refusal {
  const response: unknown = options.response
  if (response === undefined) return { response: undefined }
  if (typeof response !== 'string' || response.trim() === '') return { ok: false, reason: 'invalid', message: 'response must be a non-blank string' }
  return { response }
}
