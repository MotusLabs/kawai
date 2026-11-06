// Fetch the team groups available to a project path (agent-teams) for the
// new-session picker. Never blocking: a failed request or a malformed group
// file becomes a warning and the picker still offers "No group". Each group
// carries its allowed profiles with caps and live counts (profile routing),
// so the dialog can warn before a session exceeds a cap. It also returns the
// team's default approval policy for the path it answered
// (unify-approval-defaults D2): null until that answer, a null policy when
// the team has none or the lookup failed.
import type { ChatApprovalPolicy } from '@shared/chat'
import { useEffect, useState } from 'react'

export interface TeamGroupProfile {
  profileId: string
  cap?: number
  live: number
}

export interface TeamGroupOption {
  id: string
  label: string
  description: string
  profiles?: TeamGroupProfile[]
}

const isGroupProfile = (entry: unknown): entry is TeamGroupProfile => {
  const row = entry as Partial<TeamGroupProfile> | null
  return typeof row?.profileId === 'string' && typeof row.live === 'number' &&
    (row.cap === undefined || typeof row.cap === 'number')
}

/** The team default approval policy the lookup answered for one project path. */
export interface TeamApprovalDefaultAnswer {
  projectPath: string
  /** null = the team has no default, or the lookup failed. */
  policy: ChatApprovalPolicy | null
}

function parseGroups(data: unknown): { groups: TeamGroupOption[]; errors: string[]; approvalDefault: ChatApprovalPolicy | null } {
  const { groups, errors, warnings, approvalDefault } = (typeof data === 'object' && data !== null ? data : {}) as {
    groups?: unknown; errors?: unknown; warnings?: unknown; approvalDefault?: unknown
  }
  const valid = Array.isArray(groups)
    ? groups.filter((group): group is TeamGroupOption =>
      typeof group?.id === 'string' && typeof group?.label === 'string' &&
      typeof group?.description === 'string')
      .map(group => ({
        id: group.id, label: group.label, description: group.description,
        ...(Array.isArray(group.profiles) ? { profiles: group.profiles.filter(isGroupProfile) } : {}),
      }))
    : []
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  return {
    groups: valid, errors: [...strings(errors), ...strings(warnings)],
    approvalDefault: approvalDefault === 'auto' || approvalDefault === 'manual' ? approvalDefault : null,
  }
}

/**
 * The warning for creating a member of `group` on `profileId` when that
 * profile's cap is already reached; null when there is room or no cap.
 * Creation stays allowed — the human may add capacity on purpose.
 */
export function capWarning(group: TeamGroupOption | undefined, profileId: string): string | null {
  const entry = group?.profiles?.find(row => row.profileId === profileId)
  if (!group || !entry || entry.cap === undefined || entry.live < entry.cap) return null
  return `${group.label} already has ${entry.live} live member${entry.live === 1 ? '' : 's'} on ${profileId} ` +
    `(cap ${entry.cap}). This session will exceed it, and kawai spawns no ${profileId} member for ${group.label} ` +
    'until the count drops below the cap.'
}

export function useTeamGroups(enabled: boolean, projectPath?: string) {
  const [groups, setGroups] = useState<TeamGroupOption[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [approvalDefault, setApprovalDefault] = useState<TeamApprovalDefaultAnswer | null>(null)
  // Invalidate during render, before the next path becomes interactive. A
  // path tag alone is insufficient for A → B → A while B is still pending:
  // the last completed A answer belongs to an earlier lookup.
  const lookupPath = enabled ? projectPath?.trim() || null : null
  const [previousLookupPath, setPreviousLookupPath] = useState(lookupPath)
  if (previousLookupPath !== lookupPath) {
    setPreviousLookupPath(lookupPath)
    setApprovalDefault(null)
  }
  useEffect(() => {
    const trimmed = projectPath?.trim()
    if (!enabled || !trimmed) {
      setGroups([])
      setWarnings([])
      setApprovalDefault(null)
      return
    }
    const controller = new AbortController()
    fetch(`/api/chat/groups?projectPath=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Unable to load team groups (HTTP ${response.status}).`)
        return parseGroups(await response.json())
      })
      .then(data => {
        if (controller.signal.aborted) return
        setGroups(data.groups)
        setWarnings(data.errors)
        setApprovalDefault({ projectPath: trimmed, policy: data.approvalDefault })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setGroups([])
        setApprovalDefault({ projectPath: trimmed, policy: null })
        setWarnings([cause instanceof Error ? cause.message : String(cause)])
      })
    return () => controller.abort()
  }, [enabled, projectPath])
  return { groups, warnings, approvalDefault }
}
