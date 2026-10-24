// Reset-binding transfer (plan-workspace §6.4, design D6): when a local
// /clear, /reset, or /new composed a replacement chat for a session bound as
// a repository Architect or Lead, the successfully created replacement takes
// over that role by a CAS bind — the same keyed command a human replace uses,
// never a direct write. Both hosts (the embedded panel and full-screen
// ChatView) call this one helper, so a reset transfers exactly once from
// either.
//
// CAS safety: the expected version is the last snapshot the client observed.
// A concurrent replacement that committed first refuses the bind (`stale`),
// the store writes nothing, and the created chat simply stays unbound — the
// panel derives the conflict from the authoritative re-pushed snapshot and
// explains it. With no observed snapshot (Plans never opened this page
// load), the helper refuses to act at all: a blind expectedVersion=null bind
// could overwrite a concurrent replacement, so explicit rebind is the only
// path. Every team binding the old session follows — the conversation is the
// same one wherever it was bound as a role.
import type { SendClientMessage } from '@shared/types'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { usePlanWorkspaceScopeStore, type ResetTransferAttempt } from '../stores/planWorkspaceScopeStore'

/**
 * Transfer every repository role bound to `previousSessionId` onto the
 * created replacement `newSessionId`. Records one attempt per affected team
 * (or one skip) so a returning panel can explain what happened.
 */
export function transferBindingsOnReset(sendMessage: SendClientMessage, newSessionId: string, previousSessionId: string): void {
  const views = useTeamPlanWorkspaceStore.getState().views
  const scopeStore = usePlanWorkspaceScopeStore.getState()
  let bound = false
  for (const [teamPath, view] of Object.entries(views)) {
    const bindings = view.snapshot?.bindings
    if (!bindings) continue // no observed snapshot for this team: the version is unknown
    for (const binding of bindings) {
      if (binding.sessionId !== previousSessionId) continue
      bound = true
      scopeStore.recordAttempt(teamPath, {
        at: new Date().toISOString(), newSessionId, previousSessionId,
        action: { kind: 'sent', role: binding.role, expectedVersion: binding.version, teamPath },
      })
      sendMessage({
        type: 'team-plan-workspace-bind', teamPath, requestId: crypto.randomUUID(),
        commandId: crypto.randomUUID(), role: binding.role, sessionId: newSessionId,
        expectedVersion: binding.version,
      })
    }
  }
  if (!bound) {
    const known = Object.entries(views).filter(([, view]) => view.snapshot !== null)
    const teamPath = known.length > 0 ? known[0]![0] : ''
    scopeStore.recordAttempt(teamPath, {
      at: new Date().toISOString(), newSessionId, previousSessionId,
      action: known.length > 0 ? { kind: 'skipped-not-bound' } : { kind: 'skipped-unknown', teamPath },
    })
  }
}
