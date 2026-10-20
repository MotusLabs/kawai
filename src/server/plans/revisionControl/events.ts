// The revision-control kinds (revision-control design D3, C6): hold, pause,
// and Apply commands, each the human's, replayed by `(plan_id, command_id)`
// over the compared payload. `cites` names a strategy impact review or a
// decision card; `retain` is a whole-plan hold's narrowing; `releaseHold`
// releases a changes-scoped hold in the resolution's transaction.
import type { CommandPayload } from '../planCommands'

export type RevisionControlEventInput =
  | { kind: 'hold-placed'; commandId: string; scope: 'plan' | 'changes'; changes: string[]; rationale: string; deadline: string; cites: { kind: 'impact-review' | 'decision-card'; id: string } | null }
  | { kind: 'hold-released'; commandId: string; holdId: string; changes: string[]; retain: string[]; reason: string }
  | { kind: 'hold-extended'; commandId: string; holdId: string; deadline: string; reason: string }
  | { kind: 'pause-requested'; commandId: string; holdId: string; deadline: string; note: string }
  | { kind: 'pause-resolved'; commandId: string; pauseId: string; change: string; choice: 'continue' | 'adapt' | 'restart' | 'cancelled'; adapt: string | null; rationale: string; releaseHold: boolean }
  | { kind: 'revision-applied'; commandId: string; executionId: string; expectedRevision: number; revision: number; contentHash: string; choices: Record<string, string>; adaptations: Record<string, string>; rationale: string }

/**
 * The compared payload of one revision-control kind (revision-control D3):
 * the command name plus its own fields — trimmed prose, sorted change
 * lists, so a resend with a different input order replays.
 */
export function revisionControlCommandPayload(event: RevisionControlEventInput): CommandPayload {
  const sorted = (names: string[]): string[] => [...names].sort()
  switch (event.kind) {
    case 'hold-placed':
      return {
        command: 'hold-place', scope: event.scope, changes: sorted(event.changes),
        rationale: event.rationale.trim(), deadline: event.deadline,
        ...(event.cites ? { cites: event.cites } : {}),
      }
    case 'hold-released':
      return {
        command: 'hold-release', holdId: event.holdId, changes: sorted(event.changes),
        retain: sorted(event.retain), reason: event.reason.trim(),
      }
    case 'hold-extended':
      return { command: 'hold-extend', holdId: event.holdId, deadline: event.deadline, reason: event.reason.trim() }
    case 'pause-requested':
      return { command: 'pause', holdId: event.holdId, deadline: event.deadline, note: event.note.trim() }
    case 'pause-resolved':
      return {
        command: 'pause-resolve', pauseId: event.pauseId, change: event.change, choice: event.choice,
        adapt: event.adapt?.trim() ?? null, rationale: event.rationale.trim(), releaseHold: event.releaseHold,
      }
    case 'revision-applied':
      return {
        command: 'revision-apply', executionId: event.executionId, expectedRevision: event.expectedRevision,
        revision: event.revision, contentHash: event.contentHash, choices: event.choices,
        adaptations: event.adaptations, rationale: event.rationale.trim(),
      }
  }
}
