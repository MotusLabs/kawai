// Settings section for the chat provider environment: KEY=VALUE overrides
// (base URL, model names, gateway token) applied to Claude Chat sessions only.
// Server-backed: Apply saves this section; the modal also awaits save() before
// closing on Save. Credential values come back redacted; leaving one blank
// keeps the stored value.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ChatProviderEnvResponse,
  ChatProviderEnvSource,
  ChatProviderEnvUpdate,
} from '@shared/chatProviderSettings'

const ENDPOINT = '/api/settings/chat-provider-env'

interface Row {
  id: number
  name: string
  value: string
  /** The server holds a value this browser was never sent. */
  redacted: boolean
}

const SOURCE_LABEL: Record<ChatProviderEnvSource, string> = {
  settings: 'Using the overrides saved here.',
  environment: 'Using AGENTBOARD_CHAT_ENV from the server environment.',
  none: 'No overrides: chat sessions use the server environment.',
}

let nextRowId = 0
const toRows = (data: ChatProviderEnvResponse): Row[] =>
  Object.entries(data.env).map(([name, value]) => ({
    id: nextRowId++,
    name,
    value,
    redacted: data.redacted.includes(name),
  }))

/** Build the PUT body; returns an error message instead when rows are invalid. */
export function rowsToUpdate(rows: Row[]): ChatProviderEnvUpdate | string {
  const env: Record<string, string> = {}
  const keep: string[] = []
  for (const row of rows) {
    const name = row.name.trim()
    if (!name && !row.value) continue // untouched blank row
    if (!name) return 'Every value needs a variable name.'
    if (name in env) return `${name} appears more than once.`
    env[name] = row.value
    if (row.redacted && row.value === '') keep.push(name)
  }
  return keep.length > 0 ? { env, keep } : { env }
}

async function request(init?: RequestInit): Promise<ChatProviderEnvResponse> {
  const res = await fetch(ENDPOINT, init)
  const data = (await res.json().catch(() => ({}))) as Partial<ChatProviderEnvResponse> & {
    error?: string
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as ChatProviderEnvResponse
}

export interface ChatProviderSettingsHandle {
  /** Save pending edits, returning false when the modal must stay open. */
  save: () => Promise<boolean>
}

interface ChatProviderSettingsProps {
  onBusyChange?: (busy: boolean) => void
}

const ChatProviderSettings = forwardRef<ChatProviderSettingsHandle, ChatProviderSettingsProps>(
  function ChatProviderSettings({ onBusyChange }, ref) {
    const [rows, setRows] = useState<Row[]>([])
    const [source, setSource] = useState<ChatProviderEnvSource | null>(null)
    const [busy, setBusy] = useState(true)
    const [dirty, setDirty] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const mountedRef = useRef(true)

    // A completed request replaces every row and clears `dirty`, so editing is
    // locked while one is in flight (`busy`); otherwise edits made after Apply
    // would be silently overwritten by its response.
    const apply = (data: ChatProviderEnvResponse) => {
      if (!mountedRef.current) return
      setRows(toRows(data))
      setSource(data.source)
      setDirty(false)
      setError(null)
    }

    const run = async (promise: Promise<ChatProviderEnvResponse>): Promise<boolean> => {
      setBusy(true)
      try {
        apply(await promise)
        return mountedRef.current
      } catch (err: unknown) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    }

    useEffect(() => {
      onBusyChange?.(busy)
    }, [busy, onBusyChange])

    useEffect(() => {
      mountedRef.current = true
      void run(request())
      return () => {
        mountedRef.current = false
      }
    }, [])

    const edit = (id: number, patch: Partial<Row>) => {
      setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
      setDirty(true)
    }

    // The section sits inside the modal's <form>: Enter must apply this section,
    // not submit and close the whole modal.
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (!busy && dirty) handleApply()
    }

    const handleApply = async (): Promise<boolean> => {
      if (busy) return false
      const update = rowsToUpdate(rows)
      if (typeof update === 'string') {
        setError(update)
        return false
      }
      return run(
        request({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        })
      )
    }

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (busy) return false
        return dirty ? handleApply() : true
      },
    }))

    return (
      <div className="border-t border-border pt-4" data-testid="chat-provider-settings">
        <label className="mb-1 block text-xs text-secondary">Claude Chat Provider</label>
        <p className="mb-2 text-[10px] text-muted">
          Environment overrides for Claude Chat sessions only (e.g. ANTHROPIC_BASE_URL,
          ANTHROPIC_MODEL). Terminal sessions are unaffected. Applies to chat turns started after
          saving. Credential values are never shown; leave one blank to keep it.
        </p>

        <div className="space-y-2">
          {rows.map((row) => (
            // Stacked name over value: provider variable names run to 30+
            // characters and would be clipped beside the value at modal width.
            <div key={row.id} className="space-y-1 rounded border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="input min-w-0 flex-1 font-mono text-xs"
                  placeholder="NAME"
                  aria-label="Variable name"
                  value={row.name}
                  onChange={(e) => edit(row.id, { name: e.target.value })}
                  onKeyDown={onKeyDown}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn text-xs"
                  aria-label={`Remove ${row.name || 'variable'}`}
                  disabled={busy}
                  onClick={() => {
                    setRows((current) => current.filter((r) => r.id !== row.id))
                    setDirty(true)
                  }}
                >
                  ×
                </button>
              </div>
              <input
                className="input w-full font-mono text-xs"
                placeholder={row.redacted ? 'Stored — leave blank to keep' : 'value'}
                aria-label={`Value for ${row.name || 'new variable'}`}
                type={row.redacted ? 'password' : 'text'}
                value={row.value}
                onChange={(e) => edit(row.id, { value: e.target.value })}
                onKeyDown={onKeyDown}
                disabled={busy}
              />
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn text-xs"
            disabled={busy}
            onClick={() => {
              setRows((current) => [...current, { id: nextRowId++, name: '', value: '', redacted: false }])
              setDirty(true)
            }}
          >
            + Add Variable
          </button>
          <button
            type="button"
            className="btn btn-primary text-xs"
            disabled={busy || !dirty}
            onClick={handleApply}
            data-testid="chat-provider-apply"
          >
            Apply
          </button>
          {source === 'settings' && (
            <button
              type="button"
              className="btn text-xs"
              disabled={busy}
              onClick={() => run(request({ method: 'DELETE' }))}
              data-testid="chat-provider-reset"
            >
              Reset to Default
            </button>
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-500" data-testid="chat-provider-error">
            {error}
          </p>
        ) : (
          source && (
            <p className="mt-2 text-[10px] text-muted" data-testid="chat-provider-source">
              {dirty ? 'Unsaved changes. Click Apply or Save to persist them.' : SOURCE_LABEL[source]}
            </p>
          )
        )}
      </div>
    )
  }
)

export default ChatProviderSettings
