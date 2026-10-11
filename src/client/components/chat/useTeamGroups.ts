// Fetch the team groups available to a project path (agent-teams) for the
// new-session picker. Never blocking: a failed request or a malformed group
// file becomes a warning and the picker still offers "No group".
import { useEffect, useState } from 'react'

export interface TeamGroupOption {
  id: string
  label: string
  description: string
}

function parseGroups(data: unknown): { groups: TeamGroupOption[]; errors: string[] } {
  const { groups, errors } = (typeof data === 'object' && data !== null ? data : {}) as {
    groups?: unknown; errors?: unknown
  }
  const valid = Array.isArray(groups)
    ? groups.filter((group): group is TeamGroupOption =>
      typeof group?.id === 'string' && typeof group?.label === 'string' &&
      typeof group?.description === 'string')
    : []
  const warnings = Array.isArray(errors) ? errors.filter((error): error is string => typeof error === 'string') : []
  return { groups: valid, errors: warnings }
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
