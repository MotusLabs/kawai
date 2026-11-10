// A Claude result frame's settlement (L19-L21, R03; INV-A2 step 1, moved
// from session.ts). The first frame with a uuid binds through the CLI turn
// binder; the active turn, and any queued prompts the CLI consumed into it,
// are decided at once, and their publications run here. The session calls
// this inside the old-frame scope (common/oldFrame.ts), so nothing a
// publication reenters can reach a successor. Promotion is the caller's
// step after the scope.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
import type { DriverLifecycle } from '../lifecycle/lifecycle.js'
import type { Logger } from '../options.js'
import type { OpenTurns } from './openTurns.js'
import type { SeenResultFrames } from './resultFrames.js'
import type { CliTurnBinder } from './turnBinder.js'
import { resultErrorText, resultUuids, type Turn } from './turns.js'

export interface ResultSettlementHost {
  seenResults: SeenResultFrames
  binder: CliTurnBinder
  open: OpenTurns
  lifecycle: DriverLifecycle
  logger?: Logger
  active(): Turn | null
  emit(body: EventBody): void
}

export function settleResult(host: ResultSettlementHost, message: SDKResultMessage): void {
  const identity = host.seenResults.first(message.uuid)
  if (identity === 'unidentified') host.logger?.warn({}, 'claude_result_without_frame_uuid')
  if (identity !== 'first') return
  const uuids = resultUuids(message)
  if (host.binder.result(uuids, message.queued_turn_count) === 'drop') return
  const turn = host.active()
  if (!turn || turn.settled) return
  // Queued prompts the CLI consumed into this turn share its result.
  const absorbed = host.open.queuedWith(uuids, turn)
  for (const _ of absorbed) host.lifecycle.withdraw('queue')
  if (!host.lifecycle.result(turn.turnId)) return
  host.open.remove([turn, ...absorbed])
  const failed = message.subtype !== 'success' || message.is_error
  if (!failed && message.subtype === 'success') turn.finalText = message.result
  const error: AgentErrorInfo | null = failed ? { category: 'provider', message: resultErrorText(message) } : null
  const result = host.open.settle(turn, failed ? 'failed' : 'success', error, message.subtype, message)
  for (const queued of absorbed) {
    queued.settled = true
    queued.resolve(result)
  }
  if (failed) host.emit({ type: 'error', error: error! })
}
