// Pure frame-to-activity mapping for the chat activity indicator (design D3):
// raw stream-json frames are normalized to inputs, inputs reduce into a
// per-turn activity state, and the state projects to the ephemeral ChatActivity
// sent to clients. Side-effect free and SDK-free (frames are matched
// structurally), so tests pin shapes copied from real wire captures and the
// direct-CLI transport of replace-claude-sdk-with-cli can reuse the mapping.
// View rules (hiding during `responding`, pending requests, archived chats)
// stay client-side by design D4; this module only reports what is happening.
import type { ChatActivity, ChatActivityPhase } from '../../shared/chat'

/** One unresolved tool call of the in-flight turn. */
export interface ChatActivityToolCall {
  toolCallId: string
  tool: string
}

/**
 * Reducer state for one in-flight turn: the current phase, when its
 * projection began (wall-clock ms), and the ordered unresolved tool calls
 * (oldest first — `running_tools` names the oldest and counts the rest).
 */
export interface ChatActivityState {
  phase: ChatActivityPhase | null
  phaseStartedAt: number
  unresolvedTools: ChatActivityToolCall[]
  /** Tool named by the latest tool_use block start (preparing_tool). */
  preparingTool?: string
  /** Details of the latest system/api_retry frame (retrying). */
  retry?: { attempt: number; maxRetries: number; errorStatus?: number }
}

export function initialChatActivityState(): ChatActivityState {
  return { phase: null, phaseStartedAt: 0, unresolvedTools: [] }
}

/** Normalized activity inputs; the driver maps raw frames onto these. */
export type ChatActivityInput =
  | { type: 'turn_started' }
  | { type: 'status'; status: string }
  | { type: 'block_start'; blockType: string; tool?: string }
  | { type: 'tool_call'; toolCallId: string; tool: string }
  | { type: 'tool_result'; toolCallId: string }
  | { type: 'api_retry'; attempt: number; maxRetries: number; errorStatus?: number }
  | { type: 'request_resolved' }
  | { type: 'turn_end' }

/** Structural slice of an SDK `system` frame; keeps this module SDK-free. */
export interface ChatSystemFrameSlice {
  subtype?: string
  /** SDKStatus is `'compacting' | 'requesting' | null`. */
  status?: string | null
  attempt?: number
  max_retries?: number
  /** The CLI reports null when the failed attempt sent no status. */
  error_status?: number | null
}

/** Structural slice of a `content_block_start` content_block. */
export interface ChatContentBlockSlice {
  type: string
  /** tool_use blocks carry the tool's name. */
  name?: string
}

/**
 * A `system` frame → input, or null when it carries no activity (init,
 * thinking_tokens, unknown status values, ...). Unknown values are ignored so
 * they leave the current phase alone (design D3 risk mitigation).
 */
export function systemFrameToInput(
  frame: ChatSystemFrameSlice
): ChatActivityInput | null {
  if (frame.subtype === 'status') {
    return frame.status === 'requesting'
      ? { type: 'status', status: 'requesting' }
      : null
  }
  if (frame.subtype === 'api_retry') {
    const { attempt, max_retries, error_status } = frame
    if (typeof attempt === 'number' && typeof max_retries === 'number') {
      return {
        type: 'api_retry',
        attempt,
        maxRetries: max_retries,
        ...(typeof error_status === 'number'
          ? { errorStatus: error_status }
          : {}),
      }
    }
  }
  return null
}

/**
 * A `content_block_start` content_block → input, or null for block types that
 * carry no activity (deltas, stops, unknown block types).
 */
export function contentBlockToInput(
  block: ChatContentBlockSlice | undefined
): ChatActivityInput | null {
  if (!block) return null
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return { type: 'block_start', blockType: 'thinking' }
    case 'text':
      return { type: 'block_start', blockType: 'text' }
    case 'tool_use':
      return { type: 'block_start', blockType: 'tool_use', tool: block.name }
    default:
      return null
  }
}

/**
 * The projection without `elapsedMs` — the identity of a phase instance.
 * Phase changes are detected by comparing these bodies; only a change (or
 * `request_resolved`) starts a new clock (design D3).
 */
export function activityBody(
  state: ChatActivityState
): Omit<ChatActivity, 'elapsedMs'> | null {
  if (state.phase === null) return null
  switch (state.phase) {
    case 'preparing_tool':
      return {
        phase: state.phase,
        ...(state.preparingTool !== undefined
          ? { tool: state.preparingTool }
          : {}),
      }
    case 'running_tools':
      return {
        phase: state.phase,
        tool: state.unresolvedTools[0]?.tool,
        count: state.unresolvedTools.length,
      }
    case 'retrying':
      return { phase: state.phase, ...(state.retry ?? {}) }
    default:
      return { phase: state.phase }
  }
}

/** The current activity for clients: the body plus time spent in the phase. */
export function projectActivity(
  state: ChatActivityState,
  now = Date.now()
): ChatActivity | null {
  const body = activityBody(state)
  if (!body) return null
  return { ...body, elapsedMs: Math.max(0, now - state.phaseStartedAt) }
}

/**
 * One transition of the design D3 table. Inputs arriving while no turn is in
 * flight (phase null) are ignored except `turn_started`; unknown status values
 * and block types leave the state untouched. When the last unresolved tool
 * result arrives the phase falls back to `requesting` — the model is being
 * asked for its next response — so `running_tools` never projects with
 * count 0.
 */
export function reduceActivity(
  state: ChatActivityState,
  input: ChatActivityInput,
  now = Date.now()
): ChatActivityState {
  const next = applyInput(state, input, now)
  if (next === state) return state
  // A new phase start time is set only when the projection changes; a plain
  // phase re-entry (e.g. `status: requesting` after a tool-result fallback)
  // keeps the clock running.
  if (
    JSON.stringify(activityBody(state)) !== JSON.stringify(activityBody(next))
  ) {
    next.phaseStartedAt = now
  }
  return next
}

function applyInput(
  state: ChatActivityState,
  input: ChatActivityInput,
  now: number
): ChatActivityState {
  if (input.type === 'turn_started') {
    return withPhase(state, 'requesting')
  }
  if (state.phase === null) return state
  switch (input.type) {
    case 'status':
      return input.status === 'requesting'
        ? withPhase(state, 'requesting')
        : state
    case 'block_start':
      switch (input.blockType) {
        case 'thinking':
          return withPhase(state, 'thinking')
        case 'text':
          return withPhase(state, 'responding')
        case 'tool_use':
          return {
            ...withPhase(state, 'preparing_tool'),
            preparingTool: input.tool,
          }
        default:
          return state
      }
    case 'tool_call': {
      if (
        state.unresolvedTools.some(
          (call) => call.toolCallId === input.toolCallId
        )
      ) {
        return state
      }
      return {
        ...withPhase(state, 'running_tools'),
        unresolvedTools: [
          ...state.unresolvedTools,
          { toolCallId: input.toolCallId, tool: input.tool },
        ],
      }
    }
    case 'tool_result': {
      const unresolvedTools = state.unresolvedTools.filter(
        (call) => call.toolCallId !== input.toolCallId
      )
      return withPhase(
        { ...state, unresolvedTools },
        unresolvedTools.length > 0 ? 'running_tools' : 'requesting'
      )
    }
    case 'api_retry':
      return {
        ...withPhase(state, 'retrying'),
        retry: {
          attempt: input.attempt,
          maxRetries: input.maxRetries,
          errorStatus: input.errorStatus,
        },
      }
    case 'request_resolved':
      // The running clock must not include an approval card's wait time:
      // restart it when the request settles (design D3).
      return { ...state, phaseStartedAt: now }
    case 'turn_end':
      return { phase: null, phaseStartedAt: now, unresolvedTools: [] }
  }
}

function withPhase(
  state: ChatActivityState,
  phase: ChatActivityPhase
): ChatActivityState {
  return state.phase === phase ? state : { ...state, phase }
}
