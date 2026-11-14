// Persistence bridge for bounded tool state; all methods run inside the caller's atomic work.
import type { ChatEvent } from '../../../shared/chat'
import type { Measurement } from '../../../shared/processObservations'
import type { LiveTurn } from './chatTracker'
import type { TeamCatalogue } from './toolCalls'
import { admitCall, approval, finishTools, newToolState, resolveApproval, settleCall, watchFailures, type ClosedStreak } from './toolCallState'

export class ToolCallTracker {
  readonly names = new Map<string, Map<string, number>>()
  constructor(private readonly catalogue: TeamCatalogue) {}
  start(turn: LiveTurn, failures: number) { turn.tm = newToolState(failures) }
  watch(turn: LiveTurn, failures: number, at: string, write: (facts: ClosedStreak[]) => void) {
    if (!turn.tm) return false
    const changed=!Number.isSafeInteger(failures) || failures<0 || failures!==turn.tm.seenRecorderFailures
    write(watchFailures(turn.tm, failures, at))
    return changed
  }
  call(turn: LiveTurn, event: Extract<ChatEvent,{type:'tool_call'}>, write: (facts: ClosedStreak[]) => void): boolean {
    if (!turn.tm) return true
    if (turn.tm.calls.some(c => c.id === event.toolCallId)) return false
    const id = turn.scope.sessionId!
    const slots = this.names.get(id) ?? new Map<string,number>()
    this.names.set(id, slots)
    write(admitCall(turn.tm,slots,event.toolCallId,event.tool,this.catalogue,event.at))
    return true
  }
  result(turn: LiveTurn, event: Extract<ChatEvent,{type:'tool_result'}>, write: (facts: ClosedStreak[]) => void): Measurement | null {
    if (!turn.tm) return {}
    const result = settleCall(turn.tm,event.toolCallId,event.isError === true,typeof event.output === 'string' ? event.output : '',event.at)
    write(result.closed)
    if (result.duplicate) return null
    const call = result.call
    return { eligible: result.eligible, first: result.first,
      ...(call ? { identity: call.identity, toolKind: call.kind, label: call.label,
        identityIncomplete: call.identity === 'unknown' } : {}),
      ...(result.failureClass ? { failureClass: result.failureClass } : {}) }
  }
  request(turn: LiveTurn, event: Extract<ChatEvent,{type:'approval_request'}>) {
    if (turn.tm) approval(turn.tm,event.requestId,event.toolCallId ?? null)
  }
  resolve(turn: LiveTurn, id: string, outcome: string) {
    if (turn.tm) resolveApproval(turn.tm,id,outcome)
  }
  finish(turn: LiveTurn, at: string, partial: boolean, write: (facts: ClosedStreak[]) => void): Measurement {
    this.names.delete(turn.scope.sessionId!)
    if (!turn.tm) return { toolCoverageVersion: 0, toolFirstHistoryUnknown: true,
      toolStreakTainted: true, toolDenialIncomplete: null }
    const done = finishTools(turn.tm,at,partial)
    write(done.closed)
    return done.coverage
  }
}
