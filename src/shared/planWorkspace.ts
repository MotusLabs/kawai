// Plan workspace records and defensive parsers (plan-workspace tasks 1.1),
// SDK-independent like plans.ts. The snapshot's `workspace` carries only what
// PR A composes — plan identity, the displayed version, the repository's
// Architect/Lead bindings, and the plan's document references; later PRs add
// their sections as optional additive fields and never reshape these.
import type { PlanLifecycle, PlanRevisionStatus } from './plans'

/** The two repository conversation roles (design D6). */
export const PLAN_WORKSPACE_ROLES = ['architect', 'lead'] as const
export type PlanWorkspaceRole = (typeof PLAN_WORKSPACE_ROLES)[number]

/**
 * Names the version a workspace message addresses: an exact revision, or a
 * draft by id. Absent means the default — approved, else the newest in-review
 * revision, else the newest draft by updated_at (design D2).
 */
export type WorkspaceVersionSelector = { kind: 'revision'; revision: number } | { kind: 'draft'; draftId: string }

/**
 * Names a selected execution (design D2), additive and separate from the
 * version selector: the display may pin one execution while the displayed
 * plan version is the default or its own selection. Never part of
 * WorkspaceVersionSelector — the two are chosen independently.
 */
export interface WorkspaceExecutionSelector {
  executionId: string
}

/** The execution identity a snapshot names, with the revision it runs. */
export interface WorkspaceExecutionView {
  executionId: string
  revision: number
}

/**
 * The displayed version's identity, carrying its status so the UI can label a
 * proposed revision or a draft as such (design D2).
 */
export type WorkspaceDisplayedVersion =
  | { kind: 'revision'; revision: number; status: PlanRevisionStatus; contentHash: string }
  | { kind: 'draft'; draftId: string; contentHash: string }

export type WorkspaceBindingAvailability = 'live' | 'archived' | 'unavailable'

/** One bound role of the repository (design D6): the pointer and its current availability. */
export interface WorkspaceBindingView {
  role: PlanWorkspaceRole
  sessionId: string
  /** The CAS token; only grows (no unbind, no DELETE). */
  version: number
  availability: WorkspaceBindingAvailability
  /** The durable directory's name; null when the session was never recorded here. */
  name: string | null
}

/** A supporting document reference (design D4), metadata only — never document content. */
export interface WorkspaceRefView {
  id: string
  planId: string
  changeName: string | null
  label: string
  kind: 'local' | 'external'
  worktreeId: string | null
  relativePath: string | null
  url: string | null
  createdAt: string
}

/** The workspace projection one plan's open composes (design D1). */
export interface WorkspaceSnapshot {
  plan: { id: string; title: string; lifecycle: PlanLifecycle }
  displayedVersion: WorkspaceDisplayedVersion | null
  /** The selected execution and the revision it runs; absent while none is selected (design D2). */
  execution?: WorkspaceExecutionView
  bindings: WorkspaceBindingView[]
  references: WorkspaceRefView[]
}

/** The bind command's recorded payload (the ledger compares it field by field). */
export interface WorkspaceBindPayload {
  role: PlanWorkspaceRole
  sessionId: string
  /** The CAS token the binder saw; null = the role is unbound. */
  expectedVersion: number | null
}

/** A ref-add command's payload (design D4): supporting metadata, never document content. */
export interface WorkspaceRefPayload {
  planId: string
  label: string
  kind: 'local' | 'external'
  changeName?: string
  /** `kind: 'local'`: the listed worktree root the path resolves in. */
  worktreeId?: string
  relativePath?: string
  /** `kind: 'external'`: an https link; the server never fetches it. */
  url?: string
}

/** A ref-remove command's payload. */
export interface WorkspaceRefRemovePayload {
  refId: string
}

/**
 * Whether `value` is a relative, normalized repository path (design D4):
 * no absolute path, no `..` or `.` segment, no NUL, no backslash or network
 * path. The document reader refuses everything else.
 */
export function isRelativeWorkspacePath(value: string): boolean {
  if (value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * The version identity a workspace message attaches to (design D7): an
 * immutable revision, or a draft by id — both carrying the content hash the
 * sender saw, so a changed draft is refused rather than silently re-scoped.
 */
export type WorkspaceContextVersion =
  | { kind: 'revision'; revision: number; contentHash: string }
  | { kind: 'draft'; draftId: string; contentHash: string }

/**
 * The immutable per-message context (design D7): what the server validated
 * and stored whole for one user message. Stored snapshots survive killed
 * plans and changed files, so `planTitle` is snapshotted, never re-read.
 */
export interface WorkspaceMessageContext {
  teamId: string
  planId: string
  planTitle: string
  version: WorkspaceContextVersion
  executionId: string | null
  changeName: string | null
  documentRefId: string | null
}

/** One parsed checklist item (design D3); keys are local to the document hash and position. */
export interface WorkspaceChecklistItem {
  key: string
  text: string
  checked: boolean
  /** The item's 1-based source line in the artifact. */
  line: number
}

export interface WorkspaceChecklistSection {
  heading: string
  /** Heading depth in the source document (1 = a top-level `#`). */
  depth: number
  items: WorkspaceChecklistItem[]
}

/** A change artifact's checklist projection (design D3): a read-only view, never Kawai tasks. */
export interface WorkspaceChecklist {
  /** The source content hash the row keys are local to. */
  sourceHash: string
  sections: WorkspaceChecklistSection[]
}

export type WorkspaceHealthLevel = 'green' | 'yellow' | 'red' | 'unknown'
export type WorkspaceQuotaStatus = 'ok' | 'warning' | 'limited'

/** One passive context reading (design D5): an already-held fact, never a worker attach. */
export interface WorkspaceContextReading {
  /** The used share of the session's context window, 0..1; null when unknown. */
  used: number | null
  measuredAt: string | null
}

export interface WorkspaceQuotaReading {
  status: WorkspaceQuotaStatus | null
  /** The reported window share already used, 0..1, when the source reports one. */
  used: number | null
  resetsAt: string | null
  measuredAt: string | null
  /** Whose allowance the reading reports; a host account is not a gateway provider's. */
  source: 'profile' | 'provider' | 'account'
}

/** One agent's compact health (design D5); the dot never predicts failure or controls dispatch. */
export interface WorkspaceAgentHealth {
  level: WorkspaceHealthLevel
  context: WorkspaceContextReading | null
  quota: WorkspaceQuotaReading | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parse a version selector; null when malformed (draft/revision discrimination). */
export function parseVersionSelector(value: unknown): WorkspaceVersionSelector | null {
  if (!isRecord(value)) return null
  if (value.kind === 'revision') {
    return typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 1
      ? { kind: 'revision', revision: value.revision } : null
  }
  if (value.kind === 'draft') {
    return typeof value.draftId === 'string' && value.draftId.trim() !== '' ? { kind: 'draft', draftId: value.draftId } : null
  }
  return null
}

/** A trimmed non-empty role, or null for anything else. */
export function parseWorkspaceRole(value: unknown): PlanWorkspaceRole | null {
  return typeof value === 'string' && (PLAN_WORKSPACE_ROLES as readonly string[]).includes(value)
    ? value as PlanWorkspaceRole
    : null
}

/** Parse an execution selector; null when malformed. */
export function parseExecutionSelector(value: unknown): WorkspaceExecutionSelector | null {
  return isRecord(value) && typeof value.executionId === 'string' && value.executionId.trim() !== ''
    ? { executionId: value.executionId }
    : null
}
