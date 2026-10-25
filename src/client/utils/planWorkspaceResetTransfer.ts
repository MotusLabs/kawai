// Reset-binding transfer (plan-workspace §6.4, design D6): when a local
// /clear, /reset, or /new composed a replacement chat for a session bound as
// a repository Architect or Lead, the successfully created replacement takes
// over that role by a CAS bind — the same keyed command a human replace uses,
// never a direct write. Both hosts (the embedded panel and full-screen
// ChatView) call this one helper, so a reset transfers exactly once from
// either.
//
// The authoritative read (B3) is the team bindings slot in
// teamPlanWorkspaceStore (`teamBindings`), which both the per-plan snapshot
// and the Q1 bindings push reconcile into — so a binding known only through
// the no-plan path, or after the Plans view closed, transfers exactly the
// same. With no observed bindings at all (this page load never saw the
// team), the helper refuses to act: a blind expectedVersion=null bind could
// overwrite a concurrent replacement, so explicit rebind is the only path.
//
// CAS safety: the expected version is the last observed one. A concurrent
// replacement that committed first refuses the bind (`stale`), the store
// writes nothing, and the created chat stays unbound. The bind's requestId
// is recorded on the attempt, and the panel settles the outcome from the
// keyed `team-plan-workspace-result` (or derives an unconfirmed conflict
// from the slot at mount), explaining the binding conflict beside the
// created chat (B2) — the attempt is never write-only.
import type { SendClientMessage } from '@shared/types'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { usePlanWorkspaceScopeStore, type ResetTransferAttempt } from '../stores/planWorkspaceScopeStore'

/**
 * Transfer every repository role bound to `previousSessionId` onto the
 * created replacement `newSessionId`. Records one attempt per affected team
 * (or one skip) so a returning panel can explain what happened.
 */
export function transferBindingsOnReset(sendMessage: SendClientMessage, newSessionId: string, previousSessionId: string): void {
  const { teamBindings, views } = useTeamPlanWorkspaceStore.getState()
  const scopeStore = usePlanWorkspaceScopeStore.getState()
  let bound = false
  for (const [teamPath, bindings] of Object.entries(teamBindings)) {
    for (const binding of bindings) {
      if (binding.sessionId !== previousSessionId) continue
      bound = true
      const requestId = crypto.randomUUID()
      scopeStore.recordAttempt(teamPath, {
        at: new Date().toISOString(), newSessionId, previousSessionId,
        action: { kind: 'sent', role: binding.role, expectedVersion: binding.version, teamPath, requestId },
      })
      sendMessage({
        type: 'team-plan-workspace-bind', teamPath, requestId, commandId: crypto.randomUUID(),
        role: binding.role, sessionId: newSessionId, expectedVersion: binding.version,
      })
    }
  }
  if (!bound) {
    // Teams this client observed bindings for — the slot, or a plan snapshot.
    const known = new Set([...Object.keys(teamBindings),
      ...Object.entries(views).filter(([, view]) => view.snapshot !== null).map(([teamPath]) => teamPath)])
    const teamPath = known.values().next().value ?? ''
    scopeStore.recordAttempt(teamPath, {
      at: new Date().toISOString(), newSessionId, previousSessionId,
      action: known.size > 0 ? { kind: 'skipped-not-bound' } : { kind: 'skipped-unknown', teamPath },
    })
  }
}
