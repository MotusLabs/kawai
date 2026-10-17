// The Audit tab (execution-safety-recovery D9): the team's recorded sends
// newest first, with the range's counts (allowed sends per rule, unknown
// destinations, violations, unacknowledged), filters by verdict, rule,
// session, and time range, Load more, and the backup status footer. Host-
// agnostic like the Plans view: it owns its subscription over `teamPath`,
// and every committed row of the team marks the view stale — the view then
// re-requests its first page, so a new call appears without a reload.
// Read-only beyond Acknowledge (D10) on a violation row: the dialog arms
// one command id when it opens and keeps it while its payload is unchanged,
// so a resend after a lost result replays. Every control disables while
// disconnected. Gone sessions arrive named (`Name (gone)`) and render as
// plain text; only live or archived sessions open a chat.
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { OutboundAuditFilters, OutboundAuditRow, OutboundVerdict } from '@shared/outbound'
import { useTeamAuditStore, type AuditView } from '../../stores/teamAuditStore'
import { openParticipantChat } from '../chat/openParticipant'

const VERDICT_LABELS: Record<string, string> = {
  violation: 'Violation',
  'unknown-destination': 'Unknown destination',
  allowed: 'Allowed',
}

/** Each outcome state's label (D7 states, read-time derived). */
const OUTCOME_LABELS: Record<string, string> = {
  denied: 'Denied',
  failed: 'Failed',
  completed: 'Completed',
  'started-background': 'Started in background',
  pending: 'Pending',
  'outcome-unknown': 'Outcome unknown',
}
export const outcomeLabel = (state: string): string => OUTCOME_LABELS[state] ?? state

export default function TeamAuditView({ teamPath, view, sendMessage, connected, connectionEpoch }: {
  teamPath: string
  view: AuditView
  sendMessage: SendClientMessage
  connected: boolean
  /** Bumps on every reconnect, so subscriptions are re-sent. */
  connectionEpoch: number
}) {
  const requestSeq = useRef(0)
  // `callId` rides only the automatic opens (mount, reconnect, changed):
  // the server resolves that call's group and the store adopts the filters.
  // The Apply-filters path deliberately drops it — the owner chose new filters.
  const request = (filters: OutboundAuditFilters, callId?: string) => {
    const requestId = `audit-page-${++requestSeq.current}`
    useTeamAuditStore.getState().begin(teamPath, requestId, 'page')
    sendMessage({ type: 'team-audit-open', teamPath, requestId, filters, ...(callId !== undefined ? { callId } : {}) })
  }
  // The selection the last sent request carried (dedups the URL effect).
  const lastSelectionRequested = useRef<string | null | undefined>(undefined)
  // The tab's subscription: one authoritative page on open and every
  // reconnect; close ends it. A reconnect also drops its lost requests.
  const wasConnected = useRef(connected)
  const lastEpoch = useRef(connectionEpoch)
  useEffect(() => {
    if (!connected || !view.open) return
    const reconnected = (!wasConnected.current && connected) || (connected && lastEpoch.current !== connectionEpoch)
    wasConnected.current = connected
    lastEpoch.current = connectionEpoch
    if (reconnected) useTeamAuditStore.getState().reconnected(teamPath)
    const current = useTeamAuditStore.getState().views[teamPath]
    lastSelectionRequested.current = current?.selected ?? undefined
    request(current?.filters ?? {}, current?.selected ?? undefined)
    return () => sendMessage({ type: 'team-audit-close', teamPath })
  }, [teamPath, connected, connectionEpoch, view.open, sendMessage]) // eslint-disable-line react-hooks/exhaustive-deps
  // A call id arriving while the tab is open (the attention link, or a
  // pasted URL) re-requests with it, so the group's rows replace the view.
  useEffect(() => {
    if (!connected || !view.open) return
    if (lastSelectionRequested.current === view.selected) return
    lastSelectionRequested.current = view.selected
    request(view.filters, view.selected ?? undefined)
  }, [view.selected, connected, view.open]) // eslint-disable-line react-hooks/exhaustive-deps
  // A committed row of the team: re-request the first page (D9's replace
  // semantics) — the push itself carries no data.
  useEffect(() => {
    if (view.changed > 0 && connected && view.open) {
      lastSelectionRequested.current = view.selected ?? undefined
      request(view.filters, view.selected ?? undefined)
    }
  }, [view.changed]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    if (view.cursor === null) return
    const requestId = `audit-more-${++requestSeq.current}`
    useTeamAuditStore.getState().begin(teamPath, requestId, 'more')
    sendMessage({ type: 'team-audit-more', teamPath, requestId, filters: view.filters, cursor: view.cursor })
  }

  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="team-audit">
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update the audit view.</p>}
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border px-3 py-2" data-testid="audit-counts">
      {view.counts === null
        ? <span className="text-secondary">{view.loading ? 'Loading…' : 'No page yet.'}</span>
        : <>
          <span>
            Allowed {Object.entries(view.counts.allowedPerRule).map(([rule, n]) => `${rule} ${n}`).join(', ') || '0'}
          </span>
          <span>Unknown destinations {view.counts.unknown}</span>
          <span>Violations {view.counts.violations}</span>
          <span>Unacknowledged {view.counts.unacknowledgedViolations}</span>
        </>
      }
    </div>
    <AuditFilters teamPath={teamPath} view={view} connected={connected} onRequest={request} />
    {view.error && <p role="alert" className="border-b border-border px-3 py-2 text-chat-meta text-chat-danger">{view.error}</p>}
    <div className="flex flex-col" data-testid="audit-rows">
      {view.rows?.map(row => <AuditRow key={row.id} row={row} teamPath={teamPath} connected={connected}
        sendMessage={sendMessage} selected={view.selected === row.id} />)}
      {view.rows !== null && view.rows.length === 0 && <p className="px-3 py-2 text-secondary">No recorded sends match.</p>}
    </div>
    {view.cursor !== null && <div className="border-t border-border p-3">
      <button type="button" className="btn" data-testid="audit-load-more" disabled={!connected || view.loadingMore} onClick={loadMore}>
        {view.loadingMore ? 'Loading…' : 'Load more'}
      </button>
    </div>}
    <BackupFooter view={view} />
  </div>
}

/** The local YYYY-MM-DD of an ISO stamp (the date inputs' value). */
const isoDayOf = (stamp: string): string => {
  const [date] = stamp.split('T')
  return date ?? ''
}

/** The filters are committed as one edit — one page request per Apply. */
function AuditFilters({ teamPath, view, connected, onRequest }: {
  teamPath: string
  view: AuditView
  connected: boolean
  onRequest: (filters: OutboundAuditFilters) => void
}) {
  const [draft, setDraft] = useState<OutboundAuditFilters>(view.filters)
  const rules = Object.keys(view.counts?.allowedPerRule ?? {})
  const apply = () => {
    useTeamAuditStore.getState().setFilters(teamPath, draft)
    onRequest(draft)
  }
  return <div className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2" data-testid="audit-filters">
    <label className="flex flex-col text-chat-meta">
      Verdict
      <select aria-label="Filter by verdict" className="input" value={draft.verdict ?? ''} disabled={!connected}
        onChange={event => setDraft({ ...draft, verdict: event.target.value === '' ? undefined : event.target.value })}>
        <option value="">All verdicts</option>
        {(Object.keys(VERDICT_LABELS) as OutboundVerdict[]).map(verdict =>
          <option key={verdict} value={verdict}>{VERDICT_LABELS[verdict]}</option>)}
      </select>
    </label>
    <label className="flex flex-col text-chat-meta">
      Rule
      <input aria-label="Filter by rule" className="input" value={draft.rule ?? ''} disabled={!connected}
        list="audit-rule-options" placeholder="any rule"
        onChange={event => setDraft({ ...draft, rule: event.target.value === '' ? undefined : event.target.value })} />
      <datalist id="audit-rule-options">{rules.map(rule => <option key={rule} value={rule} />)}</datalist>
    </label>
    <label className="flex flex-col text-chat-meta">
      Destination
      <input aria-label="Filter by destination" className="input" value={draft.destination ?? ''} disabled={!connected}
        placeholder="github:origin" list="audit-destination-options"
        onChange={event => setDraft({ ...draft, destination: event.target.value === '' ? undefined : event.target.value })} />
      <datalist id="audit-destination-options">
        {[...new Set((view.rows ?? []).map(row => row.destination))].map(destination => <option key={destination} value={destination} />)}
      </datalist>
    </label>
    <label className="flex flex-col text-chat-meta">
      Session
      <input aria-label="Filter by session" className="input" value={draft.sessionId ?? ''} disabled={!connected}
        placeholder="session id"
        onChange={event => setDraft({ ...draft, sessionId: event.target.value === '' ? undefined : event.target.value })} />
    </label>
    <label className="flex flex-col text-chat-meta">
      From
      <input aria-label="From date" type="date" className="input" disabled={!connected}
        value={draft.from ? isoDayOf(draft.from) : ''}
        onChange={event => {
          if (event.target.value === '') { setDraft({ ...draft, from: undefined }); return }
          const [y, m, d] = event.target.value.split('-').map(Number)
          setDraft({ ...draft, from: new Date(y!, m! - 1, d!).toISOString() })
        }} />
    </label>
    <label className="flex flex-col text-chat-meta">
      To
      <input aria-label="To date" type="date" className="input" disabled={!connected}
        value={draft.to ? isoDayOf(draft.to) : ''}
        onChange={event => {
          // Inclusive for the owner: the day named is kept, so the store's
          // exclusive bound is local midnight of the next day (D9's range).
          if (event.target.value === '') { setDraft({ ...draft, to: undefined }); return }
          const [y, m, d] = event.target.value.split('-').map(Number)
          setDraft({ ...draft, to: new Date(y!, m! - 1, d! + 1).toISOString() })
        }} />
    </label>
    <button type="button" className="btn" data-testid="audit-apply-filters" disabled={!connected} onClick={apply}>Apply filters</button>
  </div>
}

function AuditRow({ row, teamPath, connected, sendMessage, selected }: {
  row: OutboundAuditRow
  teamPath: string
  connected: boolean
  sendMessage: SendClientMessage
  /** The URL's or the attention link's call: marked and scrolled into view (D10). */
  selected: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [note, setNote] = useState('')
  const rowRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'center' })
  }, [selected])
  // The dialog reads the view it acks in: the armed command, the refusal,
  // and the settled request all live there. A success clears the armed
  // command — the dialog closes, so a second click cannot write a second
  // acknowledgement.
  const command = useTeamAuditStore(state => state.views[teamPath]?.command ?? null)
  const dialogOpen = useRef(false)
  dialogOpen.current = dialog
  useEffect(() => {
    if (dialogOpen.current && command === null) setDialog(false)
  }, [command])
  const openDialog = () => {
    useTeamAuditStore.getState().arm(teamPath)
    setDialog(true)
  }
  const closeDialog = () => {
    useTeamAuditStore.getState().disarm(teamPath)
    setDialog(false)
  }
  const confirm = () => {
    const requestId = `audit-ack-${Math.random().toString(36).slice(2)}`
    const trimmed = note.trim()
    const commandId = useTeamAuditStore.getState().command(teamPath, JSON.stringify({ callId: row.id, note: trimmed }), requestId)
    useTeamAuditStore.getState().begin(teamPath, requestId, 'acknowledge')
    sendMessage({ type: 'team-audit-acknowledge', teamPath, requestId, callId: row.id, commandId, ...(trimmed !== '' ? { note: trimmed } : {}) })
  }
  const meta = [
    row.groupId !== undefined && `group ${row.groupId}`,
    row.profileId !== undefined && `profile ${row.profileId}`,
    row.taskId !== undefined && `task ${row.taskId}`,
    row.agentId !== undefined && `subagent ${row.agentId}`,
    row.mcpServer !== undefined && `server ${row.mcpServer}`,
    `tool ${row.tool}`,
  ].filter(Boolean).join(' · ')
  return <article ref={rowRef} className={`border-b border-border px-3 py-2 ${selected ? 'bg-surface' : ''}`}
    data-testid={`audit-row-${row.id}`} data-verdict={row.verdict} data-selected={selected || undefined}>
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-chat-meta text-secondary"><time dateTime={row.createdAt}>{row.createdAt.replace('T', ' ').slice(0, 19)}</time></span>
      <span className="font-medium" data-testid="audit-verdict">{VERDICT_LABELS[row.verdict] ?? row.verdict}</span>
      <span data-testid="audit-rule">{row.rule}</span>
      <span data-testid="audit-destination">{row.destination}</span>
      {row.session.clickable
        ? <button type="button" className="text-left underline hover:opacity-80" data-testid="audit-session"
            onClick={() => openParticipantChat(row.session.id)}>{row.session.name}</button>
        : <span data-testid="audit-session">{row.session.name}</span>}
      <span className="text-chat-meta text-secondary">{outcomeLabel(row.outcome.state)}</span>
      {row.verdict === 'violation' && <button type="button" className="btn ml-auto text-sm" data-testid="audit-acknowledge"
        disabled={!connected} onClick={openDialog}>Acknowledge</button>}
    </div>
    <p className="mt-1 text-chat-meta text-secondary">{meta} · {row.cwd}</p>
    <p className="mt-1 break-all font-mono text-chat-meta">
      {expanded ? row.command : row.command.length > 160 ? `${row.command.slice(0, 160)}…` : row.command}
      {(expanded || row.command.length <= 160) && row.truncated && ' ‹truncated›'}
    </p>
    {row.command.length > 160 && (
      <button type="button" className="text-chat-meta underline" data-testid="audit-command-toggle" onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show less' : 'Show more'}
      </button>
    )}
    {row.outcome.detail !== undefined && <p className="mt-1 break-all text-chat-meta text-secondary" data-testid="audit-outcome-detail">{row.outcome.detail}</p>}
    {dialog && <div className="mt-2 border border-border p-2" data-testid="audit-ack-dialog" role="dialog" aria-label="Acknowledge violation">
      <p className="text-chat-meta">Acknowledge {row.rule} to {row.destination} through this call. Rows and verdicts stay; a later violation raises the item again.</p>
      <textarea aria-label="Acknowledgement note" className="input mt-1" rows={2} value={note} disabled={!connected}
        placeholder="Optional note (at most 300 characters)" maxLength={300}
        onChange={event => setNote(event.target.value)} />
      <div className="mt-1 flex gap-2">
        <button type="button" className="btn btn-primary" data-testid="audit-ack-confirm"
          disabled={!connected || command?.refused === true} onClick={confirm}>Acknowledge</button>
        <button type="button" className="btn" onClick={closeDialog}>Cancel</button>
      </div>
      {command?.refused === true && <p role="alert" className="mt-1 text-chat-meta text-chat-danger">
        The command was refused — close and reopen this dialog to try again.
      </p>}
    </div>}
  </article>
}

function BackupFooter({ view }: { view: AuditView }) {
  const backups = view.backups
  return <footer className="border-t border-border px-3 py-2 text-chat-meta text-secondary" data-testid="audit-backups">
    {backups === null
      ? <span>Server-wide database backups: no status available.</span>
      : <>
        <span>Server-wide database backups in {backups.dir}: </span>
        {backups.newest.length === 0
          ? <span>none yet.</span>
          : <span>{backups.newest.map(file => `${file.reason} ${file.name} (${Math.round(file.bytes / 1024)} KB, check ${file.checked})`).join(' · ')}</span>}
        {backups.failures.length > 0 && <span data-testid="audit-backup-failures">
          {' · '}{backups.failures.length} failed backup{backups.failures.length === 1 ? '' : 's'}: {backups.failures.map(failure => `${failure.reason} ${failure.error}`).join('; ')}
        </span>}
      </>
    }
  </footer>
}
