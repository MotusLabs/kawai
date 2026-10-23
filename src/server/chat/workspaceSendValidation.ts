// The workspace-context send validation (plan-workspace §4.1, design D7,
// CP1's table V2–V8): every read happens before the driver mints anything,
// so a refusal stores no row, opens no turn, and emits no event (invariant
// I1). Fail-closed: a wrong team, a moved version or execution, a change
// outside the version, and a stale or missing document all refuse the send.
// V1 (unknown session, start-blocked) stays in the manager's send guard —
// the same refusals an unscoped send gets today.
import type { TeamIdentity } from '../team/teamIdentity'
import type { WorkspaceMessageContext, WorkspaceMessageEnvelope, WorkspaceRefView } from '../../shared/planWorkspace'
import { displayedContent, selectedDisplayedVersion, type PlanVersionInputs } from '../plans/workspace/displayedVersion'
import { readWorkspaceDocument } from '../plans/workspace/documentReader'

/** The reads validation needs, structural so tests fake them whole. */
export interface WorkspaceSendValidationDeps {
  resolveTeam(projectPath: string): Promise<TeamIdentity>
  /** The plan exists in this team; any lifecycle is a valid label (V3). */
  planForTeam(teamId: string, planId: string): { id: string; title: string } | null
  /** The plan's standing versions, as the workspace view resolves them. */
  versionInputs(planId: string): PlanVersionInputs
  /** The execution row, or null; team and plan membership are checked here. */
  execution(executionId: string): { id: string; teamId: string; planId: string; revision: number } | null
  refsOf(teamId: string, planId: string): WorkspaceRefView[]
}

export type WorkspaceSendValidation =
  | { ok: true; context: WorkspaceMessageContext }
  | { ok: false; error: string }

const refuse = (error: string): WorkspaceSendValidation => ({ ok: false, error })

/**
 * Validate one contextual send whole and return the stored snapshot it
 * records (V2–V8, in CP1's order). The returned context is the immutable
 * per-message snapshot: the plan title comes from the store, never from
 * the envelope, and the validation-only hash fields stay off it.
 */
export async function validateWorkspaceSend(
  projectPath: string,
  envelope: WorkspaceMessageEnvelope,
  deps: WorkspaceSendValidationDeps,
): Promise<WorkspaceSendValidation> {
  // V2: the envelope's team is the session's own repository team.
  const team = await deps.resolveTeam(projectPath)
  if (envelope.teamId !== team.teamId) {
    return refuse("Message is attached to another repository's plan; not sent.")
  }
  // V3: any lifecycle is a valid discussion label — context never authorizes.
  const plan = deps.planForTeam(team.teamId, envelope.planId)
  if (!plan) return refuse(`Plan not found in this repository: ${envelope.planId}`)
  const inputs = deps.versionInputs(envelope.planId)
  // V4/V5: the named version still stands at the hash the sender saw.
  const claimed = envelope.version
  if (claimed.kind === 'revision') {
    const revision = inputs.revisions.find(candidate => candidate.revision === claimed.revision)
    if (!revision) return refuse(`Plan revision ${claimed.revision} not found: ${plan.title}`)
    if (revision.contentHash !== claimed.contentHash) {
      return refuse(`Plan "${plan.title}" revision ${claimed.revision} changed since this message was attached.`)
    }
  } else {
    const draft = inputs.drafts.find(candidate => candidate.draftId === claimed.draftId)
    if (!draft) return refuse(`Plan draft ${claimed.draftId} not found: ${plan.title}`)
    if (draft.contentHash !== claimed.contentHash) {
      return refuse(`Plan draft "${claimed.draftId}" of "${plan.title}" changed since this message was attached.`)
    }
  }
  // V6: a named execution belongs to this plan and still stands at the
  // revision the envelope saw; an envelope without a revision accepts the row.
  if (envelope.executionId != null) {
    const execution = deps.execution(envelope.executionId)
    if (!execution || execution.teamId !== team.teamId || execution.planId !== envelope.planId) {
      return refuse(`Execution not found in this plan: ${envelope.executionId}`)
    }
    if (envelope.executionRevision !== undefined && envelope.executionRevision !== execution.revision) {
      return refuse(`Execution ${envelope.executionId} moved to revision ${execution.revision} since this message was attached.`)
    }
  }
  // V7: a named change is one of the named version's changes.
  if (envelope.changeName != null) {
    const displayed = selectedDisplayedVersion(inputs, claimed)
    if (!displayed) return refuse(`Plan version not found: ${plan.title}`)
    const content = displayedContent(inputs, displayed)
    if (!content.changes.some(change => change.change === envelope.changeName)) {
      return refuse(`Change "${envelope.changeName}" is not part of this plan version.`)
    }
  }
  // V8: a named document ref exists, matches the change, and a local ref's
  // file still hashes to what the sender read — by a fresh read, fail-closed.
  if (envelope.documentRefId != null) {
    const ref = deps.refsOf(team.teamId, envelope.planId).find(candidate => candidate.id === envelope.documentRefId)
    if (!ref) return refuse(`Document ref not found in this plan: ${envelope.documentRefId}`)
    if (ref.changeName !== null && ref.changeName !== envelope.changeName) {
      return refuse(`Document ref "${ref.label}" belongs to change "${ref.changeName}", not this message's change.`)
    }
    if (ref.kind === 'local') {
      if (!envelope.documentHash) return refuse('A local document ref needs the hash the sender read.')
      const read = await readWorkspaceDocument(ref.worktreeId ?? '', ref.relativePath ?? '')
      if (!read.ok) return refuse('The referenced document is gone; no current hash could be read.')
      if (read.hash !== envelope.documentHash) return refuse(`The referenced document changed since this message was attached.`)
    } else if (envelope.documentHash !== undefined) {
      return refuse('An external document ref carries no hash.')
    }
  }
  return {
    ok: true,
    context: {
      teamId: team.teamId,
      planId: plan.id,
      planTitle: plan.title,
      version: envelope.version,
      executionId: envelope.executionId ?? null,
      changeName: envelope.changeName ?? null,
      documentRefId: envelope.documentRefId ?? null,
    },
  }
}
