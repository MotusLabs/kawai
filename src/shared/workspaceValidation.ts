// workspaceValidation.ts - Defensive parsing/validation for workspace payloads.
// Used by the server to validate inbound client messages and by the client to
// tolerate snapshots produced by newer servers (extra/optional fields) and
// corrupted ones (malformed entries are dropped, never fabricated).

import type {
  ChangeRegistryEntry,
  OpenSpecChangeSummary,
  WorkspaceBranch,
  WorkspaceRepository,
  WorkspaceSnapshot,
  WorkspaceWorktree,
  WorktreeOpenSpecState,
} from './workspace'

export const WORKSPACE_MAX_FIELD_LENGTH = 4096
export const WORKSPACE_MAX_REPOSITORIES = 256
export const WORKSPACE_MAX_WORKTREES = 256
export const WORKSPACE_MAX_BRANCHES = 4096
export const WORKSPACE_MAX_CHANGES = 256

// Simplified git check-ref-format: rejects ref names git would refuse, plus
// anything that could be mistaken for an option by downstream tooling.
// Control characters (incl. NUL) are rejected separately by hasControlChars.
const GIT_REF_NAME_PATTERN = /^(?!\/|\.|-)(?!.*(?:\/\.|\/\/|\.\.|@{|[~^:?*\\]))[^\s~^:?*\\[]+(?<!\.lock|\/|\.)$/

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export interface CreateWorktreePayload {
  repositoryId: string
  branch: string
  destination: string
  launchSession?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return null
  }
  return value
}

/** True when the value is a plausible local git ref (branch) name. */
export function isValidGitRefName(name: string): boolean {
  return (
    name.length <= WORKSPACE_MAX_FIELD_LENGTH &&
    !hasControlChars(name) &&
    GIT_REF_NAME_PATTERN.test(name)
  )
}

/** True when the value is a plausible absolute filesystem path. */
export function isAbsoluteLocalPath(value: string): boolean {
  return (
    value.length > 1 &&
    value.length <= WORKSPACE_MAX_FIELD_LENGTH &&
    !value.includes('\0') &&
    value.startsWith('/')
  )
}

function parseOpenSpecChange(value: unknown): OpenSpecChangeSummary | null {
  if (!isRecord(value)) return null
  const name = boundedString(value.name, WORKSPACE_MAX_FIELD_LENGTH)
  if (name === null) return null
  const change: OpenSpecChangeSummary = { name }
  const status = optionalString(value.status)
  if (status !== undefined) change.status = status
  const completedTasks = optionalNonNegativeInteger(value.completedTasks)
  if (completedTasks !== undefined) change.completedTasks = completedTasks
  const totalTasks = optionalNonNegativeInteger(value.totalTasks)
  if (totalTasks !== undefined) change.totalTasks = totalTasks
  const lastModified = optionalString(value.lastModified)
  if (lastModified !== undefined) change.lastModified = lastModified
  return change
}

function parseOpenSpecState(value: unknown): WorktreeOpenSpecState {
  if (!isRecord(value)) return { changes: [], stale: false }
  const changes: OpenSpecChangeSummary[] = []
  if (Array.isArray(value.changes)) {
    for (const rawChange of value.changes.slice(0, WORKSPACE_MAX_CHANGES)) {
      const change = parseOpenSpecChange(rawChange)
      if (change) changes.push(change)
    }
  }
  const state: WorktreeOpenSpecState = {
    changes,
    stale: value.stale === true,
  }
  const rootPath = optionalString(value.rootPath)
  if (rootPath !== undefined) state.rootPath = rootPath
  const error = optionalString(value.error)
  if (error !== undefined) state.error = error
  return state
}

function parseWorktree(value: unknown): WorkspaceWorktree | null {
  if (!isRecord(value)) return null
  const id = boundedString(value.id, WORKSPACE_MAX_FIELD_LENGTH)
  const repositoryId = boundedString(value.repositoryId, WORKSPACE_MAX_FIELD_LENGTH)
  const path = boundedString(value.path, WORKSPACE_MAX_FIELD_LENGTH)
  const headRevision = boundedString(value.headRevision, 512)
  if (id === null || repositoryId === null || path === null || headRevision === null) {
    return null
  }
  const worktree: WorkspaceWorktree = {
    id,
    repositoryId,
    path,
    headRevision,
    detached: value.detached === true,
    isMain: value.isMain === true,
    dirty: value.dirty === true,
    openspec: parseOpenSpecState(value.openspec),
  }
  const branch = optionalString(value.branch)
  if (branch !== undefined) worktree.branch = branch
  return worktree
}

function parseBranch(value: unknown): WorkspaceBranch | null {
  if (!isRecord(value)) return null
  const name = boundedString(value.name, WORKSPACE_MAX_FIELD_LENGTH)
  const revision = boundedString(value.revision, 512)
  if (name === null || revision === null) return null
  const branch: WorkspaceBranch = { name, revision }
  const assignedWorktreeId = optionalString(value.assignedWorktreeId)
  if (assignedWorktreeId !== undefined) branch.assignedWorktreeId = assignedWorktreeId
  return branch
}

/**
 * Parse one registry entry. Malformed entries are dropped by the caller.
 * A source claiming 'worktree' without a complete id/path pair is
 * downgraded to 'registry' so downstream placement never fabricates a
 * worktree; missingInWorktree only survives on registry-source entries.
 */
function parseChangeRegistryEntry(value: unknown): ChangeRegistryEntry | null {
  if (!isRecord(value)) return null
  const base = parseOpenSpecChange(value)
  if (base === null) return null
  const worktreeId = optionalString(value.worktreeId)
  const worktreePath = optionalString(value.worktreePath)
  const hasWorktree = worktreeId !== undefined && worktreePath !== undefined
  const source: ChangeRegistryEntry['source'] =
    value.source === 'worktree' && hasWorktree ? 'worktree' : 'registry'
  const entry: ChangeRegistryEntry = { ...base, source }
  if (hasWorktree) {
    entry.worktreeId = worktreeId
    entry.worktreePath = worktreePath
    if (source === 'registry' && value.missingInWorktree === true) {
      entry.missingInWorktree = true
    }
  }
  return entry
}

function parseRepository(value: unknown): WorkspaceRepository | null {
  if (!isRecord(value)) return null
  const id = boundedString(value.id, WORKSPACE_MAX_FIELD_LENGTH)
  const name = boundedString(value.name, WORKSPACE_MAX_FIELD_LENGTH)
  const commonDir = boundedString(value.commonDir, WORKSPACE_MAX_FIELD_LENGTH)
  if (id === null || name === null || commonDir === null) return null
  if (
    !Array.isArray(value.worktrees) ||
    !Array.isArray(value.branches)
  ) {
    return null
  }
  const worktrees: WorkspaceWorktree[] = []
  for (const rawWorktree of value.worktrees.slice(0, WORKSPACE_MAX_WORKTREES)) {
    const worktree = parseWorktree(rawWorktree)
    if (worktree) worktrees.push(worktree)
  }
  const branches: WorkspaceBranch[] = []
  for (const rawBranch of value.branches.slice(0, WORKSPACE_MAX_BRANCHES)) {
    const branch = parseBranch(rawBranch)
    if (branch) branches.push(branch)
  }
  const repository: WorkspaceRepository = {
    id,
    name,
    commonDir,
    worktrees,
    branches,
    stale: value.stale === true,
  }
  if (Array.isArray(value.changeRegistry)) {
    const changeRegistry: ChangeRegistryEntry[] = []
    for (const rawEntry of value.changeRegistry.slice(0, WORKSPACE_MAX_CHANGES)) {
      const entry = parseChangeRegistryEntry(rawEntry)
      if (entry) changeRegistry.push(entry)
    }
    repository.changeRegistry = changeRegistry
  }
  const error = optionalString(value.error)
  if (error !== undefined) repository.error = error
  return repository
}

/**
 * Parse an unknown value as a workspace snapshot. Returns null when the
 * top-level shape is malformed. Individual malformed repositories, worktrees,
 * branches, and changes are dropped; optional fields absent from older or
 * newer payload revisions are tolerated.
 */
export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.repositories)) return null
  const generatedAt = boundedString(value.generatedAt, 128)
  if (generatedAt === null) return null
  const repositories: WorkspaceRepository[] = []
  for (const rawRepository of value.repositories.slice(0, WORKSPACE_MAX_REPOSITORIES)) {
    const repository = parseRepository(rawRepository)
    if (repository) repositories.push(repository)
  }
  return { repositories, generatedAt }
}

/**
 * Parse an unknown value as a create-worktree request payload. Returns null
 * when required fields are missing, malformed, or unsafe (relative path,
 * invalid ref name, oversized values).
 */
export function parseCreateWorktreePayload(value: unknown): CreateWorktreePayload | null {
  if (!isRecord(value)) return null
  const repositoryId = boundedString(value.repositoryId, WORKSPACE_MAX_FIELD_LENGTH)
  const branch = boundedString(value.branch, WORKSPACE_MAX_FIELD_LENGTH)
  const destination = boundedString(value.destination, WORKSPACE_MAX_FIELD_LENGTH)
  if (repositoryId === null || branch === null || destination === null) return null
  if (!isAbsoluteLocalPath(destination)) return null
  if (!isValidGitRefName(branch)) return null
  const payload: CreateWorktreePayload = { repositoryId, branch, destination }
  if (value.launchSession === true) payload.launchSession = true
  return payload
}

export interface CreateChangeWorktreePayload {
  repositoryId: string
  change: string
}

/**
 * True when the value is a valid OpenSpec change name for worktree seeding:
 * a single path segment (no `/`, not `.` or `..`) that is also a valid git
 * ref name, since the change name doubles as the branch name and one path
 * component of `.worktrees/<change-name>`.
 */
export function isValidChangeName(name: string): boolean {
  if (name === '.' || name === '..' || name.includes('/')) return false
  return isValidGitRefName(name)
}

/**
 * Parse an unknown value as a create-change-worktree request payload.
 * Returns null when required fields are missing, malformed, or unsafe
 * (invalid change name, oversized values).
 */
export function parseCreateChangeWorktreePayload(value: unknown): CreateChangeWorktreePayload | null {
  if (!isRecord(value)) return null
  const repositoryId = boundedString(value.repositoryId, WORKSPACE_MAX_FIELD_LENGTH)
  const change = boundedString(value.change, WORKSPACE_MAX_FIELD_LENGTH)
  if (repositoryId === null || change === null) return null
  if (!isAbsoluteLocalPath(repositoryId)) return null
  if (!isValidChangeName(change)) return null
  return { repositoryId, change }
}
