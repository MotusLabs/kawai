// UpdatePanel.tsx - the update dialog opened from the header chip. Shows the
// target release and drives the server's install action: download, checksum
// verify, all-or-restore swap, restart. The server restarts on success — the
// connection dropping here is the expected outcome, not an error. But
// "Restarting…" stays recoverable: a restart verb can fail with the socket
// intact, or a reconnect can land on a server that still offers the same
// target, so the settle window returns the panel to a retryable failure
// instead of an undismissable dialog.
import { useEffect, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useUpdateStore } from '../stores/updateStore'

type Phase = 'idle' | 'updating' | 'restarting' | 'failed'

/**
 * How long a restart may take before the panel concludes the takeover failed.
 * Re-arms on every (re)connection epoch change: whichever server the client
 * ends up talking to has this long to clear the target (a fresh build's
 * startup check pushes `update-state`), or the panel recovers to a failure.
 */
const RESTART_SETTLE_MS = 10_000

const RESTART_STALLED =
  'The update was installed, but this server is still the previous build — the restart may have failed. Check ~/.agentboard/agentboard.log for update_restart_failed, then retry.'

export default function UpdatePanel() {
  const update = useUpdateStore((state) => state.update)
  const open = useUpdateStore((state) => state.panelOpen)
  const closePanel = useUpdateStore((state) => state.closePanel)
  const connectionEpoch = useSessionStore((state) => state.connectionEpoch)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const target = update?.target ?? null

  useEffect(() => {
    // A fresh panel for a fresh target; the previous attempt's error must
    // not bleed into a later update.
    setPhase('idle')
    setError(null)
  }, [target?.tag])

  useEffect(() => {
    if (phase !== 'restarting') return
    // The POST already resolved, so a server that meant to restart has either
    // done so (the target clears and this dialog unmounts) or failed without
    // dropping the connection. Either way, outlasting the settle window on a
    // server still offering this target means the takeover never happened.
    const timer = setTimeout(() => {
      setPhase('failed')
      setError(RESTART_STALLED)
    }, RESTART_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [phase, connectionEpoch])

  if (!open || target === null) return null

  const install = async () => {
    setPhase('updating')
    setError(null)
    try {
      const response = await fetch('/api/update/install', { method: 'POST' })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Update failed (HTTP ${response.status})`)
      }
      // The server restarts as part of applying the update; this client will
      // see the socket drop and reconnect onto the new build.
      setPhase('restarting')
    } catch (cause) {
      setPhase('failed')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={phase === 'updating' ? undefined : closePanel}
      data-testid="update-panel-overlay"
    >
      <div
        role="dialog"
        aria-label="Update available"
        className="w-full max-w-md rounded border border-border bg-elevated p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 text-sm font-semibold text-primary">Update available</h2>
        <p className="mb-3 text-sm text-secondary">
          Kawai <span className="font-semibold text-primary">{target.base}</span>{' '}
          (<code className="text-xs">{target.tag}</code>) is available — this server runs{' '}
          <code className="text-xs">{update?.current}</code>.
        </p>
        {target.htmlUrl && (
          <a
            href={target.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="mb-3 block text-xs text-accent hover:underline"
          >
            Release notes
          </a>
        )}
        <p className="mb-4 text-xs text-muted">
          Updating downloads the release tarball, verifies its published SHA256, swaps the
          install, and restarts the server. The page reconnects automatically; if the UI
          looks stale afterwards, reload it once to clear the service-worker cache.
        </p>
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={closePanel}
            disabled={phase === 'updating'}
            className="h-8 rounded border border-border px-3 text-sm text-secondary hover:bg-hover disabled:opacity-50"
          >
            {phase === 'restarting' ? 'Close' : 'Not now'}
          </button>
          <button
            onClick={() => void install()}
            disabled={phase !== 'idle' && phase !== 'failed'}
            data-testid="update-install"
            className="h-8 rounded bg-accent px-3 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {phase === 'updating' ? 'Updating…' : phase === 'restarting' ? 'Restarting…' : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  )
}
