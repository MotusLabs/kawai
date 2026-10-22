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
