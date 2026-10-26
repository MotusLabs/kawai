// The displayed version's fallback order (plan-workspace design D2, decision
// Q4): the approved revision; else the newest in-review revision; else the
// newest draft by updated_at; else null — a plan with no content yet. Pure
// over the plan store's reads, so each fallback case is testable without a
// connection. An explicit selector resolves against the plan's standing
// versions and names nothing when the revision or draft is gone; the caller
// refuses that rather than silently selecting another record (design D8).
import type { PlanContent, PlanDraft, PlanRevision } from '../../../shared/plans'
import type { WorkspaceDisplayedVersion, WorkspaceVersionSelector } from '../../../shared/planWorkspace'

export interface PlanVersionInputs {
  approved: PlanRevision | null
  revisions: PlanRevision[]
  drafts: PlanDraft[]
}

const asRevision = (revision: PlanRevision): WorkspaceDisplayedVersion => ({
  kind: 'revision', revision: revision.revision, status: revision.status, contentHash: revision.contentHash,
})

/** The default order: approved, else newest in-review, else newest draft (draftId breaks an updated_at tie). */
export function defaultDisplayedVersion({ approved, revisions, drafts }: PlanVersionInputs): WorkspaceDisplayedVersion | null {
  if (approved) return asRevision(approved)
  const inReview = revisions.filter(revision => revision.status === 'in_review').sort((a, b) => b.revision - a.revision)[0]
  if (inReview) return asRevision(inReview)
  const draft = [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.draftId.localeCompare(a.draftId))[0]
  return draft ? { kind: 'draft', draftId: draft.draftId, contentHash: draft.contentHash } : null
}

/** An explicit selector against the plan's standing versions; null when it names nothing. */
export function selectedDisplayedVersion(inputs: PlanVersionInputs, selector: WorkspaceVersionSelector): WorkspaceDisplayedVersion | null {
  if (selector.kind === 'draft') {
    const draft = inputs.drafts.find(candidate => candidate.draftId === selector.draftId)
    return draft ? { kind: 'draft', draftId: draft.draftId, contentHash: draft.contentHash } : null
  }
  const revision = inputs.revisions.find(candidate => candidate.revision === selector.revision)
  return revision ? asRevision(revision) : null
}

/** The displayed version's content, resolved against the same inputs that named it. */
export function displayedContent(inputs: PlanVersionInputs, version: WorkspaceDisplayedVersion): PlanContent {
  if (version.kind === 'draft') {
    return inputs.drafts.find(candidate => candidate.draftId === version.draftId)!.content
  }
  return inputs.revisions.find(candidate => candidate.revision === version.revision)!.content
}
