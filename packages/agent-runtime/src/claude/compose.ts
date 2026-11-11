// R4 Claude prompt composition (design §2's fourth exception). The host's
// composer runs synchronously once per send, right after its beforeSubmit
// accepted, and may add only `pasted_content` strings and a peer `origin` to
// that one prompt's SDK message. Its result is checked exactly and copied
// before anything else can see it, so no later mutation reaches the prompt
// and no field beyond those two can be supplied. A throw, a thenable or any
// other shape refuses the send with category `context`; a thenable is still
// handed to the caller's owner so its settlement is never detached.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '../errors.js'
import type { ComposePrompt, PromptEnvelope, SubmitContext } from '../options.js'

/** A checked, copied envelope; frozen so no observer can change it. */
export type ComposedEnvelope = Readonly<PromptEnvelope>

function invalid(why: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'context', message: `the prompt composition callback returned ${why}` })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as PromiseLike<unknown>).then === 'function'
}

/**
 * Run the composer for one accepted submission. Returns null when there is
 * none or it returned undefined (the prompt stays byte-identical).
 * `ownThenable` receives an asynchronous result so its owner joins it.
 */
export function composeEnvelope(compose: ComposePrompt | undefined, submission: SubmitContext, ownThenable: (pending: PromiseLike<unknown>) => void): ComposedEnvelope | null {
  if (!compose) return null
  let result: unknown
  try {
    result = compose({ ...submission })
  } catch (error) {
    throw new AgentRuntimeError({ category: 'context', message: 'the prompt composition callback threw' }, [error])
  }
  if (result === undefined) return null
  if (isThenable(result)) {
    ownThenable(result)
    throw invalid('a promise; it must answer synchronously')
  }
  if (!plainRecord(result)) throw invalid('a value that is not an envelope object')
  const unknown = Object.keys(result).filter((key) => key !== 'pastedContent' && key !== 'origin')
  if (unknown.length > 0) throw invalid(`unsupported fields: ${unknown.join(', ')}`)
  const envelope: PromptEnvelope = {}
  if (result.pastedContent !== undefined) {
    const pasted = result.pastedContent
    if (!Array.isArray(pasted) || pasted.some((entry) => typeof entry !== 'string')) throw invalid('pastedContent that is not an array of strings')
    envelope.pastedContent = Object.freeze([...(pasted as string[])])
  }
  if (result.origin !== undefined) {
    if (!plainRecord(result.origin)) throw invalid('an origin that is not a peer origin object')
    const { kind, from: sender, ...rest } = result.origin
    if (kind !== 'peer' || typeof sender !== 'string' || Object.keys(rest).length > 0) throw invalid('an origin other than a peer kind with a string sender')
    envelope.origin = Object.freeze({ kind: 'peer', from: sender })
  }
  return Object.freeze(envelope)
}

/** The envelope's fields as the outer SDK message carries them, freshly copied for this message. */
export function envelopeFields(envelope: ComposedEnvelope | null | undefined): Pick<SDKUserMessage, 'pasted_content' | 'origin'> {
  if (!envelope) return {}
  return {
    ...(envelope.pastedContent ? { pasted_content: [...envelope.pastedContent] } : {}),
    ...(envelope.origin ? { origin: { kind: 'peer', from: envelope.origin.from } as SDKUserMessage['origin'] } : {}),
  }
}
