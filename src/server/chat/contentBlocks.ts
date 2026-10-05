// Claude conversation content-block shapes, shared by the live SDK stream
// (ChatSessionDriver) and transcript replay (transcriptReplay). SDK-specific
// types stay out of here: these helpers only read the JSON shapes the CLI
// writes to transcripts and the SDK streams as messages.
import type { ChatQuestion } from '../../shared/chat'

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'
export { ASK_USER_QUESTION_TOOL }

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
