// Fetch public profile metadata for a project path (a `.kawai` directory in
// the project or above it extends the catalog); cancellation prevents stale
// modal responses. Catalog file failures arrive as non-blocking warnings —
// the rest of the catalog remains usable.
import { useCallback, useEffect, useState } from 'react'
import type { ClaudeProfileMetadata } from '@shared/chat'

interface ClaudeProfileCatalogResponse {
  profiles: ClaudeProfileMetadata[]
  errors: string[]
}

function parseCatalog(data: unknown): ClaudeProfileCatalogResponse {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid Claude profile catalog.')
  const { profiles, errors } = data as { profiles?: unknown; errors?: unknown }
  if (!Array.isArray(profiles) || !profiles.some(profile => profile?.id === 'default') ||
      !profiles.every(profile => typeof profile?.id === 'string' && typeof profile?.label === 'string')) {
    throw new Error('Invalid Claude profile catalog.')
  }
  const warnings = Array.isArray(errors) ? errors.filter((error): error is string => typeof error === 'string') : []
  return { profiles, errors: warnings }
}

export function useClaudeProfiles(enabled: boolean, projectPath?: string) {
  const [profiles, setProfiles] = useState<ClaudeProfileMetadata[]>([])
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setWarnings([])
    const trimmed = projectPath?.trim()
    const url = trimmed
      ? `/api/chat/profiles?projectPath=${encodeURIComponent(trimmed)}`
      : '/api/chat/profiles'
    fetch(url, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Unable to load Claude profiles (HTTP ${response.status}).`)
        return parseCatalog(await response.json())
      })
      .then(data => {
        if (controller.signal.aborted) return
        setProfiles(data.profiles)
        setWarnings(data.errors)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [enabled, attempt, projectPath])
  return { profiles, error, warnings, loading, retry }
}
