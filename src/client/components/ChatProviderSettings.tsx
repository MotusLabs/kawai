// Settings credential section (provider-credential-store S5): the write-only
// editor over /api/settings/credentials. The listing shows each variable's
// name, kind, set/blank state, source, and override/collision marks — never a
// value. Setting or replacing a value means typing it anew into an input that
// always starts empty; Blank, Clear, and changing the kind are explicit acts.
// Outcomes and refusals render the server's fixed text only, and an applied
// but not durable save shows its warning (never a retry). The modal's Save
// sends any value still typed into an input before it closes.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import type {
  CredentialKind,
  CredentialListing,
  CredentialListingRow,
  CredentialMutationOutcome,
  CredentialRefusal,
} from '@shared/credentials'

const ENDPOINT = '/api/settings/credentials'

const SOURCE_LABEL: Record<CredentialListingRow['source'], string> = {
  store: 'Saved here',
  seed: 'AGENTBOARD_CHAT_ENV',
}

const KIND_LABEL: Record<CredentialKind, string> = {
  'launch-env': 'Launch variable',
  'secret-source': 'Secret source',
}

const OTHER_KIND: Record<CredentialKind, CredentialKind> = {
  'launch-env': 'secret-source',
  'secret-source': 'launch-env',
}

/** One request; a refusal throws its fixed text, never a raw response. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => null)) as (T & Partial<CredentialRefusal>) | null
  if (!res.ok || data === null) throw new Error(data?.error || 'The credential request failed.')
  return data
}

/** A listing of the expected shape; anything else is a failed request, never a crash. */
function isListing(value: unknown): value is CredentialListing {
  const listing = value as Partial<CredentialListing> | null
  return typeof listing === 'object' && listing !== null && Array.isArray(listing.rows)
    && typeof listing.store === 'object' && listing.store !== null
    && typeof listing.migration === 'object' && listing.migration !== null
    && Array.isArray(listing.migration.skipped) && Array.isArray(listing.migration.ignored)
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const nameUrl = (name: string) => `${ENDPOINT}/${encodeURIComponent(name)}`

export interface ChatProviderSettingsHandle {
  /** Send pending typed values, returning false when the modal must stay open. */
  save: () => Promise<boolean>
}

interface ChatProviderSettingsProps {
  onBusyChange?: (busy: boolean) => void
}

const ChatProviderSettings = forwardRef<ChatProviderSettingsHandle, ChatProviderSettingsProps>(
  function ChatProviderSettings({ onBusyChange }, ref) {
    const [listing, setListing] = useState<CredentialListing | null>(null)
    // Typed replacement values per variable; always start empty (write-only).
    const [typed, setTyped] = useState<Record<string, string>>({})
    const [newName, setNewName] = useState('')
    const [newValue, setNewValue] = useState('')
    const [newKind, setNewKind] = useState<CredentialKind>('launch-env')
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null)
    const mountedRef = useRef(true)

    useEffect(() => {
      onBusyChange?.(busy)
    }, [busy, onBusyChange])

    useEffect(() => {
      mountedRef.current = true
      setBusy(true)
      request<CredentialListing>(ENDPOINT)
        .then((data) => {
          if (!isListing(data)) throw new Error('The credential request failed.')
          if (mountedRef.current) setListing(data)
        })
        .catch((err: unknown) => { if (mountedRef.current) setError(err instanceof Error ? err.message : 'The credential request failed.') })
        .finally(() => { if (mountedRef.current) setBusy(false) })
      return () => {
        mountedRef.current = false
      }
    }, [])

    /** Run one mutation; on success the typed input it consumed is cleared. */
    const mutate = async (path: string, init: RequestInit, consumed?: () => void): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const outcome = await request<CredentialMutationOutcome>(path, init)
        if (!isListing(outcome.listing)) throw new Error('The credential request failed.')
        if (!mountedRef.current) return false
        setListing(outcome.listing)
        setNotice({ text: outcome.message, warning: outcome.applied && !outcome.durable })
        consumed?.()
        return true
      } catch (err: unknown) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : 'The credential request failed.')
        return false
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    }

    const setValue = (name: string, value: string, kind: CredentialKind) =>
      mutate(nameUrl(name), json('PUT', { value, kind }), () =>
        setTyped((current) => {
          const next = { ...current }
          delete next[name]
          return next
        })
      )

    const addNew = () =>
      mutate(nameUrl(newName.trim()), json('PUT', { value: newValue, kind: newKind }), () => {
        setNewName('')
        setNewValue('')
      })

    /** The modal's Save: every value still typed, then the new variable. */
    const savePending = async (): Promise<boolean> => {
      for (const [name, value] of Object.entries(typed)) {
        if (value === '') continue
        const kind = listing?.rows.find((row) => row.name === name)?.kind ?? 'launch-env'
        if (!(await setValue(name, value, kind))) return false
      }
      if (newName.trim() !== '' && !(await addNew())) return false
      return true
    }

    useImperativeHandle(ref, () => ({
      save: async () => (busy ? false : savePending()),
    }))

    // Inside the modal's <form>: Enter applies this input, never closes the modal.
    const onEnter = (action: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (!busy) action()
    }

    const migration = listing?.migration
    return (
      <div className="border-t border-border pt-4" data-testid="chat-provider-settings">
        <label className="mb-1 block text-xs text-secondary">Chat Credentials</label>
        <p className="mb-2 text-[10px] text-muted">
          Variables for chat sessions, stored in ~/.kawai/credentials.json (owner-only). Values are
          never shown again: type a value to set or replace it. Launch variables reach Claude
          launches as themselves; secret sources reach an agent only through a provider binding.
          Changes apply at the next agent launch.
        </p>

        {listing && !listing.store.ok && (
          <p role="alert" className="mb-2 text-xs text-red-500" data-testid="credential-store-state">
            {listing.store.text}
          </p>
        )}
        {migration && migration.state === 'pending' && migration.text && (
          <p className="mb-2 text-xs text-yellow-500" data-testid="credential-migration">{migration.text}</p>
        )}
        {migration && migration.skipped.length > 0 && (
          <p className="mb-2 text-[10px] text-muted" data-testid="credential-migration-skipped">
            {migration.skipped.map((name) => `Legacy Settings ${name} not migrated: the store already holds ${name}.`).join(' ')}
          </p>
        )}
        {migration && migration.ignored.length > 0 && (
          <p className="mb-2 text-[10px] text-muted" data-testid="credential-migration-ignored">
            Legacy Settings values found after the migration are not used: {migration.ignored.join(', ')}.
          </p>
        )}

        <div className="space-y-2">
          {(listing?.rows ?? []).map((row) => (
            <div key={row.name} className="space-y-1 rounded border border-border p-2" data-testid={`credential-row-${row.name}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{row.name}</span>
                <span className="text-muted">
                  {row.kind ? KIND_LABEL[row.kind] : 'Inherited'} · {row.state === 'blank' ? 'blank' : 'set'} · {SOURCE_LABEL[row.source]}
                  {row.overriding ? ' · overrides the environment' : ''}
                </span>
              </div>
              {row.collision && (
                <p className="text-[10px] text-yellow-500" data-testid={`credential-collision-${row.name}`}>
                  {row.name} is a registered credential name, so it is not delivered under its own name. Bind it in a
                  provider catalog entry, or use a different variable name.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-0 flex-1 font-mono text-xs"
                  type="password"
                  autoComplete="off"
                  placeholder={row.source === 'store' ? 'Type a new value to replace' : 'Type a value to save here'}
                  aria-label={`New value for ${row.name}`}
                  value={typed[row.name] ?? ''}
                  onChange={(e) => setTyped((current) => ({ ...current, [row.name]: e.target.value }))}
                  onKeyDown={onEnter(() => void setValue(row.name, typed[row.name] ?? '', row.kind ?? 'launch-env'))}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn text-xs"
                  disabled={busy || !(typed[row.name] ?? '')}
                  onClick={() => void setValue(row.name, typed[row.name] ?? '', row.kind ?? 'launch-env')}
                >
                  Set
                </button>
                <button type="button" className="btn text-xs" disabled={busy}
                  onClick={() => void setValue(row.name, '', row.kind ?? 'launch-env')}>
                  Blank
                </button>
                {row.source === 'store' && row.kind && (
                  <>
                    <button type="button" className="btn text-xs" disabled={busy}
                      aria-label={`Make ${row.name} a ${KIND_LABEL[OTHER_KIND[row.kind]].toLowerCase()}`}
                      onClick={() => void mutate(`${nameUrl(row.name)}/reclassify`, json('POST', { kind: OTHER_KIND[row.kind!] }))}>
                      Make {KIND_LABEL[OTHER_KIND[row.kind]].toLowerCase()}
                    </button>
                    <button type="button" className="btn text-xs" disabled={busy} aria-label={`Clear ${row.name}`}
                      onClick={() => void mutate(nameUrl(row.name), { method: 'DELETE' })}>
                      Clear
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className="input min-w-0 flex-1 font-mono text-xs" placeholder="NAME" aria-label="New variable name"
            value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onEnter(() => void addNew())} disabled={busy} />
          <input className="input min-w-0 flex-1 font-mono text-xs" type="password" autoComplete="off" placeholder="value"
            aria-label="New variable value" value={newValue} onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={onEnter(() => void addNew())} disabled={busy} />
          <select className="input text-xs" aria-label="New variable kind" value={newKind}
            onChange={(e) => setNewKind(e.target.value as CredentialKind)} disabled={busy}>
            <option value="launch-env">{KIND_LABEL['launch-env']}</option>
            <option value="secret-source">{KIND_LABEL['secret-source']}</option>
          </select>
          <button type="button" className="btn btn-primary text-xs" disabled={busy || newName.trim() === ''}
            onClick={() => void addNew()} data-testid="credential-add">
            Add
          </button>
        </div>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-500" data-testid="chat-provider-error">{error}</p>
        ) : notice ? (
          <p className={`mt-2 text-[10px] ${notice.warning ? 'text-yellow-500' : 'text-muted'}`}
            data-testid={notice.warning ? 'credential-not-durable' : 'credential-outcome'}>
            {notice.text}
          </p>
        ) : null}
      </div>
    )
  }
)

export default ChatProviderSettings
