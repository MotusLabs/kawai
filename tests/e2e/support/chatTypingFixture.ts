// Deterministic, dated history shared by browser and render-work regression tests.
import type { ChatEvent } from '../../../src/shared/chat'

export function typingHistory(count = 500): ChatEvent[] {
  const events: ChatEvent[] = []
  for (let i = 0; i < count; i++) {
    const base = { id: `history-${i}`, sequence: 0, at: new Date(Date.UTC(2026, 9, 15, 10, i)).toISOString(), turnId: `turn-${i}` }
    events.push(i % 2 === 0
      ? { ...base, type: 'user_message', text: `Question ${i}: review the next change.` }
      : { ...base, type: 'assistant_text', messageId: `message-${i}`, text: `### Response ${i}\n\nA **formatted** response with [a link](https://example.com).\n\n- First point\n- Second point\n\n\`\`\`ts\nconst value = ${i}\n\`\`\`` })
    if (i % 20 === 1) {
      events.push({ ...base, id: `call-${i}`, type: 'tool_call', toolCallId: `tool-${i}`, tool: 'Read', input: { file_path: '/repo/src/example.ts' } },
        { ...base, id: `result-${i}`, type: 'tool_result', toolCallId: `tool-${i}`, output: 'Fixture tool output', isError: false })
    }
  }
  return events
}
