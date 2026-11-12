// The Codex driver's activity observations (task-752c9e4c C1; design §2 rows
// 47/176): the rules Kawai's in-tree Codex driver applied, over the shared
// reducer (../common/activity.ts), published through the host's onActivity
// only when the projected phase or its clock changed.
// - From the published events: turn_started opens `requesting`; a non-empty
//   assistant delta is a text block (`responding`); a tool call and its
//   result open and close `running_tools`; a resolved request restarts the
//   clock; turn_completed and turn_interrupted end the turn (null).
// - From the current turn's notifications: reasoning deltas and a started
//   reasoning item are a thinking block; an `error` notification that will
//   retry is one retry (`retrying`, attempt 1 of 1).
// Scope: the session feeds only events it publishes (current generation,
// bound turns) and only notifications it routed to the open turn, so a
// retired, foreign or settled turn's frame cannot revive the activity; the
// reducer ignores everything but turn_started while no turn is in flight.
import { activityBody, initialChatActivityState, projectActivity, reduceActivity, type ChatActivityInput, type ChatActivityState } from '../common/activity.js'
import type { AgentEvent } from '../events.js'
import type { Activity } from '../activity.js'

const REASONING = new Set(['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta'])

/** The activity input a published event carries, or null. */
function eventInput(event: AgentEvent): ChatActivityInput | null {
  switch (event.type) {
    case 'turn_started':
      return { type: 'turn_started' }
    case 'assistant_delta':
      return event.delta === '' ? null : { type: 'block_start', blockType: 'text' }
    case 'tool_call':
      return { type: 'tool_call', toolCallId: event.toolCallId, tool: event.tool }
    case 'tool_result':
      return { type: 'tool_result', toolCallId: event.toolCallId }
    case 'request_resolved':
      return { type: 'request_resolved' }
    case 'turn_completed':
    case 'turn_interrupted':
      return { type: 'turn_end' }
    default:
      return null
  }
}

/** The activity input an open turn's notification carries, or null. */
function notificationInput(method: string, params: Record<string, unknown>): ChatActivityInput | null {
  if (REASONING.has(method)) return { type: 'block_start', blockType: 'thinking' }
  if (method === 'item/started') {
    const item = params.item as { type?: unknown } | undefined
    return item?.type === 'reasoning' ? { type: 'block_start', blockType: 'thinking' } : null
  }
  if (method === 'error' && params.willRetry === true) return { type: 'api_retry', attempt: 1, maxRetries: 1 }
  return null
}

export class CodexActivity {
  private state: ChatActivityState = initialChatActivityState()

  constructor(private readonly publish: (activity: Activity | null) => void) {}

  /** A published event of this session. */
  event(event: AgentEvent): void {
    const input = eventInput(event)
    if (input) this.feed(input)
  }

  /** A notification the session routed to the open turn. */
  notification(method: string, params: Record<string, unknown>): void {
    const input = notificationInput(method, params)
    if (input) this.feed(input)
  }

  private feed(input: ChatActivityInput): void {
    const previous = this.state
    this.state = reduceActivity(previous, input)
    const changed = JSON.stringify(activityBody(previous)) !== JSON.stringify(activityBody(this.state)) || previous.phaseStartedAt !== this.state.phaseStartedAt
    if (changed) this.publish(projectActivity(this.state))
  }
}
