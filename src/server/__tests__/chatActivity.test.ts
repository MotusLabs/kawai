import { describe, expect, test } from 'bun:test'
import type { ChatActivityInput } from '../chat/chatActivity'
import {
  contentBlockToInput,
  initialChatActivityState,
  projectActivity,
  reduceActivity,
  systemFrameToInput,
} from '../chat/chatActivity'

// Frame shapes below are copied from real wire captures
// (~/.agentboard/chat-wire/*.jsonl) so parser drift from the CLI's
// stream-json protocol is caught here, per design D3's risk note.

/** system/status frame as captured on the wire. */
const STATUS_REQUESTING_FRAME = {
  type: 'system',
  subtype: 'status',
  status: 'requesting',
  session_id: '1fdf8d0e-51aa-46fb-a1a8-98f7b29e675e',
  uuid: 'f7074449-208a-48b9-aa9b-1967a0da1a26',
}

/** system/api_retry frame as captured on the wire. */
const API_RETRY_FRAME = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 567,
  error_status: 504,
  error: 'server_error',
  session_id: '1fdf8d0e-51aa-46fb-a1a8-98f7b29e675e',
  uuid: '71cfb66a-97d7-44a0-9e3e-1229768d5199',
}

/** content_block payloads as captured on the wire. */
const THINKING_BLOCK = { type: 'thinking', thinking: '', signature: '' }
const TEXT_BLOCK = { type: 'text', text: '' }
const toolUseBlock = (name: string) => ({
  type: 'tool_use',
  id: 'call_98a90dc852344607aeab9d88',
  name,
  input: {},
})

describe('systemFrameToInput', () => {
  test('maps status: requesting and api_retry frames', () => {
    expect(systemFrameToInput(STATUS_REQUESTING_FRAME)).toEqual({
      type: 'status',
      status: 'requesting',
    })
    expect(systemFrameToInput(API_RETRY_FRAME)).toEqual({
      type: 'api_retry',
      attempt: 1,
      maxRetries: 10,
      errorStatus: 504,
    })
  })

  test('unknown status values, subtypes, and partial retries map to null', () => {
    expect(
      systemFrameToInput({ subtype: 'status', status: 'connected' })
    ).toBeNull()
    const thinkingTokens = { subtype: 'thinking_tokens', estimated_tokens: 1 }
    expect(systemFrameToInput(thinkingTokens)).toBeNull()
    const init = { subtype: 'init', tools: [] }
    expect(systemFrameToInput(init)).toBeNull()
    // A retry missing fields cannot be labeled; ignore it wholesale.
    expect(
      systemFrameToInput({ subtype: 'api_retry', attempt: 2, max_retries: 10 })
    ).toBeNull()
  })
})

describe('contentBlockToInput', () => {
  test('maps thinking, redacted thinking, text, and tool_use blocks', () => {
    expect(contentBlockToInput(THINKING_BLOCK)).toEqual({
      type: 'block_start',
      blockType: 'thinking',
    })
    const redacted = { type: 'redacted_thinking', data: 'base64' }
    expect(contentBlockToInput(redacted)).toEqual({
      type: 'block_start',
      blockType: 'thinking',
    })
    expect(contentBlockToInput(TEXT_BLOCK)).toEqual({
      type: 'block_start',
      blockType: 'text',
    })
    expect(contentBlockToInput(toolUseBlock('Edit'))).toEqual({
      type: 'block_start',
      blockType: 'tool_use',
      tool: 'Edit',
    })
    expect(contentBlockToInput(undefined)).toBeNull()
  })

  test('unknown block types map to null', () => {
    expect(contentBlockToInput({ type: 'server_tool_use' })).toBeNull()
    expect(contentBlockToInput({ type: 'web_search_tool_result' })).toBeNull()
  })
})

describe('reduceActivity', () => {
  test('turn_started and status: requesting enter requesting once', () => {
    let state = initialChatActivityState()
    state = reduceActivity(state, { type: 'turn_started' }, 1_000)
    expect(projectActivity(state, 1_500)).toEqual({
      phase: 'requesting',
      elapsedMs: 500,
    })
    // A requesting status for the same request is not a new phase.
    state = reduceActivity(
      state,
      systemFrameToInput(STATUS_REQUESTING_FRAME)!,
      9_000
    )
    expect(projectActivity(state, 9_500)).toEqual({
      phase: 'requesting',
      elapsedMs: 8_500,
    })
  })

  test('thinking and text block starts switch phases with fresh clocks', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      contentBlockToInput(THINKING_BLOCK)!,
      2_000
    )
    expect(projectActivity(state, 2_100)).toEqual({
      phase: 'thinking',
      elapsedMs: 100,
    })
    state = reduceActivity(state, contentBlockToInput(TEXT_BLOCK)!, 5_000)
    expect(projectActivity(state, 5_050)).toEqual({
      phase: 'responding',
      elapsedMs: 50,
    })
    // Re-entering the same block type keeps the clock (projection unchanged).
    state = reduceActivity(
      state,
      contentBlockToInput(TEXT_BLOCK)!,
      7_000
    )
    expect(projectActivity(state, 7_050)).toEqual({
      phase: 'responding',
      elapsedMs: 2_050,
    })
  })

  test('tool_use block start then tool_call runs the named tool', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      contentBlockToInput(toolUseBlock('Edit'))!,
      1_000
    )
    expect(projectActivity(state, 1_100)).toEqual({
      phase: 'preparing_tool',
      tool: 'Edit',
      elapsedMs: 100,
    })
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Edit' },
      3_000
    )
    expect(projectActivity(state, 3_100)).toEqual({
      phase: 'running_tools',
      tool: 'Edit',
      count: 1,
      elapsedMs: 100,
    })
    // A duplicate tool_call event changes nothing (no clock restart).
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Edit' },
      9_000
    )
    expect(projectActivity(state, 9_100)).toEqual({
      phase: 'running_tools',
      tool: 'Edit',
      count: 1,
      elapsedMs: 6_100,
    })
  })

  test('several unresolved tools name the oldest and count the rest', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Bash' },
      1_000
    )
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_b', tool: 'Read' },
      4_000
    )
    expect(projectActivity(state, 4_100)).toEqual({
      phase: 'running_tools',
      tool: 'Bash',
      count: 2,
      elapsedMs: 100,
    })
    // Resolving the oldest leaves the newer one; count change restarts clock.
    state = reduceActivity(
      state,
      { type: 'tool_result', toolCallId: 'call_a' },
      6_000
    )
    expect(projectActivity(state, 6_050)).toEqual({
      phase: 'running_tools',
      tool: 'Read',
      count: 1,
      elapsedMs: 50,
    })
  })

  test('resolving the last tool falls back to requesting, never count zero', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Bash' },
      1_000
    )
    state = reduceActivity(
      state,
      { type: 'tool_result', toolCallId: 'call_a' },
      8_000
    )
    expect(projectActivity(state, 8_050)).toEqual({
      phase: 'requesting',
      elapsedMs: 50,
    })
  })

  test('api_retry reports attempt, maximum, and error status per attempt', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(state, systemFrameToInput(API_RETRY_FRAME)!, 2_000)
    expect(projectActivity(state, 2_100)).toEqual({
      phase: 'retrying',
      attempt: 1,
      maxRetries: 10,
      errorStatus: 504,
      elapsedMs: 100,
    })
    // The next attempt is a new retry phase instance.
    state = reduceActivity(
      state,
      systemFrameToInput({ ...API_RETRY_FRAME, attempt: 2 })!,
      6_000
    )
    expect(projectActivity(state, 6_050)).toEqual({
      phase: 'retrying',
      attempt: 2,
      maxRetries: 10,
      errorStatus: 504,
      elapsedMs: 50,
    })
    // The successful re-request leaves retrying.
    state = reduceActivity(
      state,
      systemFrameToInput(STATUS_REQUESTING_FRAME)!,
      7_000
    )
    expect(projectActivity(state, 7_050)).toEqual({
      phase: 'requesting',
      elapsedMs: 50,
    })
  })

  test('request_resolved restarts the clock without changing the phase', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Bash' },
      1_000
    )
    // The approval card waited 5s; the running clock starts at resolution.
    state = reduceActivity(state, { type: 'request_resolved' }, 6_000)
    expect(projectActivity(state, 6_050)).toEqual({
      phase: 'running_tools',
      tool: 'Bash',
      count: 1,
      elapsedMs: 50,
    })
  })

  test('turn end clears the phase and the unresolved set', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      0
    )
    state = reduceActivity(
      state,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Bash' },
      1_000
    )
    state = reduceActivity(state, { type: 'tool_call', toolCallId: 'call_b', tool: 'Task' }, 2_000)
    state = reduceActivity(state, { type: 'turn_end' }, 3_000)
    expect(projectActivity(state, 3_000)).toBeNull()
    expect(state.unresolvedTools).toEqual([])
    // A later turn starts fresh; stale tool ids never leak into it.
    state = reduceActivity(state, { type: 'turn_started' }, 4_000)
    expect(projectActivity(state, 4_100)).toEqual({
      phase: 'requesting',
      elapsedMs: 100,
    })
  })

  test('inputs while no turn is in flight are ignored', () => {
    const idle = initialChatActivityState()
    const inputs: ChatActivityInput[] = [
      systemFrameToInput(STATUS_REQUESTING_FRAME)!,
      contentBlockToInput(THINKING_BLOCK)!,
      { type: 'tool_call', toolCallId: 'call_a', tool: 'Bash' },
      { type: 'tool_result', toolCallId: 'call_a' },
      { type: 'request_resolved' },
      { type: 'turn_end' },
    ]
    for (const input of inputs) {
      expect(reduceActivity(idle, input, 1_000)).toBe(idle)
    }
  })

  test('elapsed time never runs backwards', () => {
    let state = reduceActivity(
      initialChatActivityState(),
      { type: 'turn_started' },
      5_000
    )
    // A clock reading earlier than the phase start clamps to zero.
    expect(projectActivity(state, 4_000)).toEqual({
      phase: 'requesting',
      elapsedMs: 0,
    })
  })
})
