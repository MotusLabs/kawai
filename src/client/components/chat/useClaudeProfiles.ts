// Fetch public profile metadata for a project path (a `.kawai` directory in
// the project or above it extends the catalog); cancellation prevents stale
// modal responses.
import { useCallback, useEffect, useState } from 'react'
import type { ClaudeProfileMetadata } from '@shared/chat'

export function useClaudeProfiles(enabled: boolean, projectPath?: string) {
  const [profiles, setProfiles] = useState<ClaudeProfileMetadata[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const trimmed = projectPath?.trim()
    const url = trimmed
      ? `/api/chat/profiles?projectPath=${encodeURIComponent(trimmed)}`
      : '/api/chat/profiles'
    fetch(url, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Unable to load Claude profiles (HTTP ${response.status}).`)
        const data: unknown = await response.json()
        if (!Array.isArray(data) || !data.some(profile => profile?.id === 'default') ||
            !data.every(profile => typeof profile?.id === 'string' && typeof profile?.label === 'string')) {
          throw new Error('Invalid Claude profile catalog.')
        }
        return data as ClaudeProfileMetadata[]
      })
      .then(data => { if (!controller.signal.aborted) setProfiles(data) })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [enabled, attempt, projectPath])
  return { profiles, error, loading, retry }
}
