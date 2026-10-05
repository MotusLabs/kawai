// Loopback-only Anthropic message fixture shared by real SDK smoke checks.
export function mockMessageResponse(body: Record<string, unknown>, tool = false): Response {
  const content = tool
    ? [{ type: 'tool_use', id: 'tool_profile_smoke', name: 'Bash', input: { command: "node -e \"console.log('profile-smoke-approved')\"", description: 'Verify approval bridge' } }]
    : [{ type: 'text', text: 'verified' }]
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } }
  if (!body.stream) return Response.json(message)
  const block = content[0]!
  const start = tool ? { ...block, input: {} } : { type: 'text', text: '' }
  const delta = tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify((block as { input: unknown }).input) }
    : { type: 'text_delta', text: 'verified' }
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}
