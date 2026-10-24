// Client-local captured message scope (plan-workspace §6.3, design D7),
// keyed by chat session beside chatStore's per-session drafts. A scope is
// captured once, when a draft first becomes nonempty under a workspace host;
// later plan/version/change/execution/document navigation never mutates a
// nonempty draft's capture — a differing selection is explained and replaced
// only by the explicit attach/replace action. Emptying the text drops the
// scope, so its lifetime matches the draft's; reload drops both (the same
// client-local semantics as drafts). Sends from the full-screen view are
// unscoped: only a workspace host reads a scope.
//
// The store also records reset-binding transfer attempts (§6.4): what the
// transfer helper sent, and the skips it refused to make. Outcomes are
// derived against the authoritative workspace snapshots, never stored as
// final results — a committed bind re-pushes the snapshot that proves it.
import { create } from 'zustand'
import type { WorkspaceMessageEnvelope } from '@shared/planWorkspace'

/** A draft's captured send context, frozen when captured. */
export interface CapturedWorkspaceScope {
  envelope: WorkspaceMessageEnvelope
  /** The visible selection at capture time, for the mismatch explanation. */
  planTitle: string
  capturedAt: string
}

/** A reset transfer attempt recorded by planWorkspaceResetTransfer (§6.4). */
export interface ResetTransferAttempt {
  at: string
  newSessionId: string
  previousSessionId: string
  /** What the helper did: sent a CAS bind, or refused to act and why. */
  action:
    | { kind: 'sent'; role: 'architect' | 'lead'; expectedVersion: number; teamPath: string; requestId: string }
    | { kind: 'skipped-not-bound' }
    | { kind: 'skipped-unknown'; teamPath: string }
  /** The bind command's keyed result once it arrived; unset while the wire
      answer is outstanding (D6: a refusal leaves the winner bound and the
      created chat unbound, and the panel explains exactly that). */
  outcome?: { ok: boolean; error: string | null }
}

/** Kept per team so a returning panel explains what a full-screen reset did. */
const MAX_ATTEMPTS_PER_TEAM = 5

interface PlanWorkspaceScopeState {
  scopes: Record<string, CapturedWorkspaceScope | null>
  attempts: Record<string, ResetTransferAttempt[]>
  setScope: (sessionId: string, scope: CapturedWorkspaceScope | null) => void
  recordAttempt: (teamPath: string, attempt: ResetTransferAttempt) => void
  /** The keyed result of a transfer bind (B2): settled on the attempt that
      carries the requestId, wherever its team key lives. */
  recordTransferOutcome: (requestId: string, outcome: { ok: boolean; error: string | null }) => void
}

export const usePlanWorkspaceScopeStore = create<PlanWorkspaceScopeState>(set => ({
  scopes: {},
  attempts: {},
  setScope: (sessionId, scope) => set(state => {
    const current = state.scopes[sessionId] ?? null
    if (current === scope || (current !== null && scope !== null
      && JSON.stringify(current.envelope) === JSON.stringify(scope.envelope))) return state
    const scopes = { ...state.scopes }
    if (scope === null) delete scopes[sessionId]
    else scopes[sessionId] = scope
    return { scopes }
  }),
  recordAttempt: (teamPath, attempt) => set(state => {
    const kept = [...(state.attempts[teamPath] ?? []), attempt].slice(-MAX_ATTEMPTS_PER_TEAM)
    return { attempts: { ...state.attempts, [teamPath]: kept } }
  }),
  recordTransferOutcome: (requestId, outcome) => set(state => {
    let changed = false
    const attempts: Record<string, ResetTransferAttempt[]> = {}
    for (const [teamPath, kept] of Object.entries(state.attempts)) {
      const next = kept.map(attempt => {
        if (attempt.action.kind !== 'sent' || attempt.action.requestId !== requestId
          || attempt.outcome) return attempt
        changed = true
        return { ...attempt, outcome }
      })
      attempts[teamPath] = next
    }
    return changed ? { attempts } : state
  }),
}))

/**
 * A contextual send is pending from submit until the session's next
 * user_message proves acceptance or the send's correlated refusal (Q2)
 * restores it. The client-minted `requestId` is the only refusal
 * correlation: an unrelated error never touches the pending entry, and a
 * resend never happens (D7: reconnect restores history, not sends). The
 * whole captured scope is kept so a refusal restores the attachment chip
 * exactly as it was.
 */
export const pendingContextSends = new Map<string, { text: string; scope: CapturedWorkspaceScope; requestId: string }>()

/** True when two envelopes name the same context (used for the mismatch line). */
export const sameEnvelope = (a: WorkspaceMessageEnvelope, b: WorkspaceMessageEnvelope): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
