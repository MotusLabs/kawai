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
  /** The runtime projection (3.1): per-change states, holders, and outside work; absent until §3 wires it. */
  runtime?: import('./planWorkspaceRuntime').WorkspaceRuntimeView
  /** Passive readings of the relevant same-team sessions (3.2); absent until §3 wires it. */
  health?: WorkspaceAgentReading[]
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

/**
 * The wire envelope a client attaches to a chat-send (design D7): what the
 * sender saw when they composed the message. `executionRevision` and
 * `documentHash` are validation-only and never stored — the stored context
 * (WorkspaceMessageContext) keeps the snapshot the server validated.
 */
export interface WorkspaceMessageEnvelope {
  teamId: string
  planId: string
  version: WorkspaceContextVersion
  executionId?: string | null
  /** Validation-only: compared against the execution row's revision (V6). */
  executionRevision?: number
  changeName?: string | null
  documentRefId?: string | null
  /** Validation-only: the document hash the sender read (V8). */
  documentHash?: string
}

/** One parsed checklist item (design D3); keys are local to the document hash and position. */
export interface WorkspaceChecklistItem {
  key: string
  text: string
  checked: boolean
  /** The item's 1-based source line in the artifact. */
  line: number
  /** Nesting depth in the source list, 1 = a top-level item (additive, 2.2). */
  depth?: number
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

/**
 * One document's provenance and last-valid content (design D4, 2.4). The
 * view is the server's memory of one subscribed source: `availability` is the
 * source's state at the last check, and `stale` labels held content that is
 * last-valid rather than current — a deleted source reads `missing` with its
 * last-valid content still held, labelled stale. `executionMatch` compares
 * only a current read against the selected execution's pin; a missing or
 * last-valid file is never presented as a historical execution input, so it
 * reads `unknown` (never inferred).
 */
export type WorkspaceDocumentAvailability = 'current' | 'missing'
export type WorkspaceExecutionMatch = 'match' | 'mismatch' | 'unknown'

export interface WorkspaceDocumentView {
  worktreeId: string
  relativePath: string
  /** What the held content is; null while nothing is held. */
  kind: 'markdown' | 'image' | null
  availability: WorkspaceDocumentAvailability
  /** True when the held content is last-valid, not the source's current bytes. */
  stale: boolean
  /** The last check's refusal code when nothing current was served; null otherwise. */
  reason: string | null
  executionMatch: WorkspaceExecutionMatch
  /** The execution the match names; null when none was selected or found. */
  executionId: string | null
  contentHash: string | null
  size: number | null
  mtimeMs: number | null
  /** Markdown text only; images never ride WS — the asset route serves bytes. */
  text: string | null
}

/**
 * Why a checklist subscription serves no projection (2.4): the change
 * resolution's named states (2.1) plus the artifact's own unreadability.
 */
export interface WorkspaceChecklistUnavailable {
  state: 'missing' | 'missing-in-worktree' | 'ambiguous' | 'cli-unavailable' | 'unreadable'
  message: string
}

/**
 * One canonical artifact's wire address (plan-workspace 5.3, S2/S3): a lazy
 * descriptor only — kind plus the normalized path relative to the source
 * worktree's listed root. Hash, size, mtime and availability never ride the
 * enumeration; they are observed per selected document through
 * `team-plan-workspace-document`, so unobserved metadata stays unknown
 * instead of fabricated.
 */
export interface WorkspaceArtifactDescriptor {
  kind: string
  relativePath: string
}

/**
 * Where the canonical copy lives (Lead b57a7360): named by an exact listed
 * worktree root — the wire `worktreeId`, never the resolver's absolute
 * change or archive root. An archive names its entry (`YYYY-MM-DD-<name>`).
 */
export type WorkspaceArtifactsSource =
  | { kind: 'main' | 'worktree'; worktreeId: string }
  | { kind: 'archive'; worktreeId: string; entry: string }

/**
 * One change's canonical artifact enumeration (5.3): the descriptor list, or
 * the named refusal. `uncontained` is the fail-closed state for an artifact
 * that does not lexically stay inside the source worktree's listed root —
 * never mapped, never exposed. Messages name no absolute path.
 */
export type WorkspaceArtifactsView =
  | {
      ok: true
      changeName: string
      source: WorkspaceArtifactsSource
      artifacts: WorkspaceArtifactDescriptor[]
    }
  | {
      ok: false
      state: 'missing' | 'missing-in-worktree' | 'ambiguous' | 'cli-unavailable' | 'uncontained'
      message: string
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

/**
 * One exposed agent's passive readings (design D5, LC3): identity plus
 * relevance — a current holder of linked work, or a bound conversation role.
 * Read from already-held telemetry only; opening or inspecting never starts,
 * restores, attaches, sends, or refreshes anything.
 */
export interface WorkspaceAgentReading {
  sessionId: string
  name: string | null
  relevance: 'holder' | 'architect' | 'lead'
  context: WorkspaceContextReading | null
  quota: WorkspaceQuotaReading | null
  /**
   * False when the quota reading reports the host account's allowance while
   * the session routes to a gateway provider, or routing is unconfirmed
   * (design D5): the reading stays inspectable and is excluded from
   * aggregation.
   */
  quotaApplicable: boolean
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

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/**
 * Defensive parse of a chat-send's workspace context, fail-closed (design
 * D7): an absent field is an unscoped send (today's behavior), while a
 * present-but-malformed envelope parses to null and the caller refuses the
 * send rather than silently dropping the context.
 */
export function parseWorkspaceMessageEnvelope(value: unknown): WorkspaceMessageEnvelope | null {
  if (!isRecord(value) || !nonEmptyString(value.teamId) || !nonEmptyString(value.planId)) return null
  const raw = isRecord(value.version) ? value.version : null
  let version: WorkspaceContextVersion | null = null
  if (raw?.kind === 'revision') {
    const { revision, contentHash } = raw
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 && nonEmptyString(contentHash)) {
      version = { kind: 'revision', revision, contentHash }
    }
  } else if (raw?.kind === 'draft') {
    const { draftId, contentHash } = raw
    if (nonEmptyString(draftId) && nonEmptyString(contentHash)) {
      version = { kind: 'draft', draftId, contentHash }
    }
  }
  if (!version) return null
  const envelope: WorkspaceMessageEnvelope = { teamId: value.teamId, planId: value.planId, version }
  if (value.executionId !== undefined && !(value.executionId === null || nonEmptyString(value.executionId))) return null
  if (value.executionId !== undefined) envelope.executionId = value.executionId as string | null
  if (value.executionRevision !== undefined) {
    const { executionRevision } = value
    if (typeof executionRevision !== 'number' || !Number.isInteger(executionRevision) || executionRevision < 1) return null
    envelope.executionRevision = executionRevision
  }
  if (value.changeName !== undefined && !(value.changeName === null || nonEmptyString(value.changeName))) return null
  if (value.changeName !== undefined) envelope.changeName = value.changeName as string | null
  if (value.documentRefId !== undefined && !(value.documentRefId === null || nonEmptyString(value.documentRefId))) return null
  if (value.documentRefId !== undefined) envelope.documentRefId = value.documentRefId as string | null
  if (value.documentHash !== undefined) {
    if (!nonEmptyString(value.documentHash)) return null
    envelope.documentHash = value.documentHash
  }
  return envelope
}

/**
 * The plain-text context block a contextual submit pastes beside the typed
 * text (design D7): stable labeled lines, full hashes, no XML — the CLI may
 * wrap the entry in its own tags. Absent optional facts read `none`.
 */
export function workspaceContextBlock(context: WorkspaceMessageContext): string {
  const version = context.version.kind === 'revision'
    ? `revision ${context.version.revision} (hash ${context.version.contentHash})`
    : `draft ${context.version.draftId} (hash ${context.version.contentHash})`
  return [
    `Plan: ${context.planTitle} (${context.planId})`,
    `Version: ${version}`,
    `Execution: ${context.executionId ?? 'none'}`,
    `Change: ${context.changeName ?? 'none'}`,
    `Document: ${context.documentRefId ?? 'none'}`,
    `Team: ${context.teamId}`,
  ].join('\n')
}

/**
 * The one-line attachment label a transcript row shows for a stored message
 * context (§6.3): the exact facts the server validated, never the client's
 * current selection. A proposal revision reads "in review" only through its
 * caller — this label states identity, not approval.
 */
export function workspaceContextLabel(context: WorkspaceMessageContext): string {
  const version = context.version.kind === 'revision'
    ? `revision ${context.version.revision} (${shortContextHash(context.version.contentHash)})`
    : `draft ${context.version.draftId} (${shortContextHash(context.version.contentHash)})`
  const parts = [
    `Plan: ${context.planTitle} · ${version}`,
    context.executionId ? `Execution: ${context.executionId}` : null,
    context.changeName ? `Change: ${context.changeName}` : null,
    context.documentRefId ? `Document: ${context.documentRefId}` : null,
  ].filter(part => part !== null)
  return parts.join(' · ')
}

const shortContextHash = (hash: string): string => hash.slice(0, 8)
