// Fetch the team groups available to a project path (agent-teams) for the
// new-session picker. Never blocking: a failed request or a malformed group
// file becomes a warning and the picker still offers "No group". Each group
// carries its allowed profiles with caps and live counts (profile routing),
// so the dialog can warn before a session exceeds a cap.
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

function parseGroups(data: unknown): { groups: TeamGroupOption[]; errors: string[] } {
  const { groups, errors, warnings } = (typeof data === 'object' && data !== null ? data : {}) as {
    groups?: unknown; errors?: unknown; warnings?: unknown
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
  return { groups: valid, errors: [...strings(errors), ...strings(warnings)] }
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
  useEffect(() => {
    const trimmed = projectPath?.trim()
    if (!enabled || !trimmed) {
      setGroups([])
      setWarnings([])
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
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setGroups([])
        setWarnings([cause instanceof Error ? cause.message : String(cause)])
      })
    return () => controller.abort()
  }, [enabled, projectPath])
  return { groups, warnings }
}
