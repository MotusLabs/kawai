// The Plans query's meaning (plan-workspace 7.1, design D8): the grammar
// layer (`teamLocation`) decodes and re-encodes; this module validates each
// selector against the loaded authoritative data and names the store patch a
// URL asks for. Loading is never invalid — a selector whose data has not
// arrived waits (no notice, no apply) and validates once it has. A selector
// the loaded data does not name falls back with an explanatory notice and is
// never silently traded for a different record; the URL keeps the stale
// selector until the next user navigation rewrites it, so a reload explains
// again. Absent fields name no selection: the default version, the latest
// execution, no change, no document, the retained role.
import type {
  PlanWorkspaceRole, WorkspaceVersionSelector,
} from '@shared/planWorkspace'
import type { PlansLocationQuery } from '../../utils/teamLocation'
import { PLAN_WORKSPACE_ROLES } from '@shared/planWorkspace'

/** The workspace selections a URL (or the store) addresses. */
export interface WorkspaceAddressableState {
  version: WorkspaceVersionSelector | null
  executionId: string | null
  selectedChange: string | null
  selectedDocument: { worktreeId: string; relativePath: string } | null
}

/** A validated query's store patch (only differing fields); the role rides the team, not the plan view. */
export interface PlansSelectionPatch extends Partial<WorkspaceAddressableState> {
  role?: PlanWorkspaceRole
}

/** The loaded data a query validates against; a null list is still loading (pending, not invalid). */
export interface PlansQueryLoadedData {
  revisions: number[] | null
  draftIds: string[] | null
  executionIds: string[] | null
  /** The displayed version's change names. */
  changeNames: string[] | null
  /** The team's discovered worktree root paths. */
  worktreePaths: string[] | null
}

/** The version parameter's wire form, shared with the version picker's option values. */
export const versionParamOf = (selector: WorkspaceVersionSelector): string =>
  selector.kind === 'revision' ? `rev:${selector.revision}` : `draft:${selector.draftId}`

/** The version parameter's meaning; null when it names neither form (malformed). */
export function versionSelectorFromParam(value: string): WorkspaceVersionSelector | null {
  const revision = /^rev:([1-9]\d*)$/.exec(value)
  if (revision) return { kind: 'revision', revision: Number(revision[1]) }
  const draft = /^draft:(.+)$/.exec(value)
  if (draft) return { kind: 'draft', draftId: draft[1] }
  return null
}

/**
 * The URL query of the workspace's current state plus a user's patch: the
 * store is the truth and the URL mirrors it, so a pick from a fallback state
 * drops the stale selector that caused the notice. Default selections emit
 * no field — absence is the default, never an implied identity.
 */
export function plansQueryOfState(state: WorkspaceAddressableState & { role: PlanWorkspaceRole }, patch?: Partial<PlansSelectionPatch>): PlansLocationQuery | undefined {
  const merged = { ...state, ...patch }
  const query: PlansLocationQuery = {}
  if (merged.version !== null) query.version = versionParamOf(merged.version)
  if (merged.executionId !== null) query.execution = merged.executionId
  if (merged.selectedChange !== null) query.change = merged.selectedChange
  if (merged.selectedDocument !== null) {
    query.document = { worktreeId: merged.selectedDocument.worktreeId, relativePath: merged.selectedDocument.relativePath }
  }
  if (merged.role === 'lead') query.role = 'lead'
  return Object.keys(query).length > 0 ? query : undefined
}

/** What a fallback notice names as shown: the selection the workspace actually keeps. */
const describeVersion = (selector: WorkspaceVersionSelector | null): string =>
  selector === null ? 'the default version'
    : selector.kind === 'revision' ? `revision ${selector.revision}` : `draft “${selector.draftId.slice(0, 8)}”`

/**
 * Validate a query against the loaded data. Valid fields become patch
 * entries (only where they differ from `current`, so applying is cheap);
 * present-but-invalid fields produce one notice each and no patch — the
 * notice names what actually stays shown, which on a fresh load is the
 * default and after a Back to a stale selector is the retained selection;
 * fields whose data has not loaded are skipped whole (pending, not invalid).
 */
export function applyPlansQuery(query: PlansLocationQuery, loaded: PlansQueryLoadedData, current: WorkspaceAddressableState & { role: PlanWorkspaceRole }): { patch: PlansSelectionPatch; notices: string[] } {
  const patch: PlansSelectionPatch = {}
  const notices: string[] = []
  if (query.version !== undefined && loaded.revisions !== null && loaded.draftIds !== null) {
    const selector = versionSelectorFromParam(query.version)
    const known = selector !== null && (selector.kind === 'revision'
      ? loaded.revisions.includes(selector.revision)
      : loaded.draftIds.includes(selector.draftId))
    if (!known) {
      const named = selector === null
        ? `version “${query.version}”, which is neither a revision nor a draft`
        : selector.kind === 'revision'
          ? `revision ${selector.revision}, which this plan does not have`
          : `draft “${selector.draftId.slice(0, 8)}”, which this plan does not have`
      notices.push(`Link names ${named} — showing ${describeVersion(current.version)}.`)
    } else if (query.version !== (current.version === null ? undefined : versionParamOf(current.version))) {
      patch.version = selector
    }
  }
  if (query.execution !== undefined && loaded.executionIds !== null) {
    if (!loaded.executionIds.includes(query.execution)) {
      notices.push(`Link names execution “${query.execution.slice(0, 8)}”, which this plan does not have — showing ${current.executionId === null ? 'the latest execution' : `execution “${current.executionId.slice(0, 8)}”`}.`)
    } else if (query.execution !== current.executionId) {
      patch.executionId = query.execution
    }
  }
  if (query.change !== undefined && loaded.changeNames !== null) {
    if (!loaded.changeNames.includes(query.change)) {
      notices.push(`Link names change “${query.change}”, which the displayed version does not list — the map keeps ${current.selectedChange === null ? 'no change selected' : `“${current.selectedChange}” selected`}.`)
    } else if (query.change !== current.selectedChange) {
      patch.selectedChange = query.change
    }
  }
  if (query.document !== undefined && loaded.worktreePaths !== null) {
    const document = query.document
    if (document.worktreeId === '' || document.relativePath === '') {
      notices.push('Link names a document without a worktree or path — no document opened.')
    } else if (!loaded.worktreePaths.includes(document.worktreeId)) {
      notices.push('Link names a document in a worktree this page has not discovered — no document opened.')
    } else if (current.selectedDocument?.worktreeId !== document.worktreeId
      || current.selectedDocument?.relativePath !== document.relativePath) {
      patch.selectedDocument = { worktreeId: document.worktreeId, relativePath: document.relativePath }
    }
  }
  if (query.role !== undefined) {
    if (!(PLAN_WORKSPACE_ROLES as readonly string[]).includes(query.role)) {
      notices.push(`Link names role “${query.role}” — showing ${current.role === 'architect' ? 'Architect' : 'Lead'}.`)
    } else if (query.role !== current.role) {
      patch.role = query.role as PlanWorkspaceRole
    }
  }
  return { patch, notices }
}
