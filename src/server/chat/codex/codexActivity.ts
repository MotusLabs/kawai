// The Codex driver's activity projection (chat-activity): reduce one frame
// into the session's activity state and publish it only when the projected
// phase or its clock changed. Extracted verbatim from CodexSessionDriver to
// keep the driver under the file cap; no behavior of its own.
import {
  activityBody,
  projectActivity,
  reduceActivity,
  type ChatActivityInput,
  type ChatActivityState,
} from '../chatActivity'
import type { CodexEventDraft } from './codexEvents'

/**
 * Reduce `input` into `state` and publish the projected activity when it
 * changed — the same publish rule every chat driver applies.
 */
export function publishCodexActivity(
  state: ChatActivityState,
  input: ChatActivityInput,
  onActivity: (activity: ReturnType<typeof projectActivity>) => void,
): ChatActivityState {
  const next = reduceActivity(state, input)
  const changed = JSON.stringify(activityBody(state)) !== JSON.stringify(activityBody(next))
    || state.phaseStartedAt !== next.phaseStartedAt
  if (changed) onActivity(projectActivity(next))
  return next
}

/** The activity frame a protocol draft projects, or null when it moves nothing. */
export function activityFrameFor(draft: CodexEventDraft): ChatActivityInput | null {
  if (draft.type === 'turn_started') return { type: 'turn_started' }
  if (draft.type === 'turn_completed' || draft.type === 'turn_interrupted') return { type: 'turn_end' }
  if (draft.type === 'request_resolved') return { type: 'request_resolved' }
  return null
}
