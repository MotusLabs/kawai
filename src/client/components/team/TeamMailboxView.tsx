// The Mailbox view (team-waiting-reasons, team-workspace-pages 5.3): every
// unsettled message of the team in its delivery section with its waiting
// reason, laid out for scanning. The sections that need action — Held for
// review, Dead letters, Parked — lead and start expanded; the rest start
// collapsed behind their counts. Rows collapse to one line (sender,
// recipient, age, priority, the reason's immediate blocker, the body's first
// line) and expand to the full body, every constraint, and any handoff
// detail. A search narrows every section over senders, recipients, bodies,
// and reason text (D6); empty sections can be hidden; routing is its own
// collapsible section. Every delivery operation stays: Cancel, Retry,
// Discard, Hand off, and Reload routing rules.
import { useEffect, useMemo, useState } from 'react'
import type { LiveParticipant } from '@shared/participants'
import { resolveParticipant } from '@shared/participants'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '@shared/team'
import type { SendClientMessage } from '@shared/types'
import type { MailboxView } from '../../stores/teamMailboxStore'
import { constraintLabel, deadLetterLabel, elapsedLabel } from '../../utils/waitingLabels'
import { copyText } from '../../utils/copyText'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import ParkedHandOff from './ParkedHandOff'
import TeamRoutingSection from './TeamRoutingSection'

const basename = (worktree: string): string => worktree.split('/').filter(Boolean).at(-1) ?? worktree

/** Fixed section order; the first three are the action sections (5.3). */
const ACTION_SECTIONS = 3
interface MailboxSection {
  key: string
  matches: (row: TeamMessage, now: number) => boolean
}
const SECTIONS: MailboxSection[] = [
  { key: 'Held for review', matches: row => row.state === 'uncertain' },
  { key: 'Dead letters', matches: row => row.state === 'dead' },
  { key: 'Parked', matches: row => row.state === 'parked' },
  { key: 'Starting agent', matches: row => row.state === 'spawning' },
  {
    key: 'Queued',
    matches: (row, now) => (row.state === 'queued' && (!row.deliverAt || Date.parse(row.deliverAt) <= now)) || row.state === 'awaiting-request',
  },
  { key: 'Receiving', matches: row => row.state === 'claimed' },
  {
    key: 'Scheduled',
    matches: (row, now) => row.state === 'queued' && !!row.deliverAt && Date.parse(row.deliverAt) > now,
  },
]

/** Sections that start collapsed once a team's Mailbox first opens. */
const DEFAULT_COLLAPSED = SECTIONS.slice(ACTION_SECTIONS).map(section => section.key).concat(['Routing'])
/** Marks that the default collapsed set was applied, so it is never re-seeded. */
const DEFAULTS_APPLIED = '#defaults'

/** The one-line reason for a row: its immediate blocker, or its state's own line. */
function blockerLine(row: TeamMessage, reason: WaitingReason | undefined): string {
  if (reason) return constraintLabel(reason.blocker)
  if (row.state === 'dead') return deadLetterLabel(row.reason ?? 'dead')
  if (row.state === 'uncertain') return 'Held for review — retry or discard'
  if (row.state === 'parked') return 'Parked after a provider limit'
  if (row.state === 'awaiting-request') return 'Waiting for the recipient’s approval or answer'
  return row.state
}

/** Everything a search matches over (D6): participants (ids and resolved names), body, reason text. */
function searchableText(row: TeamMessage, reason: WaitingReason | undefined, sessions: ReadonlyArray<LiveParticipant>): string {
  // The names a row displays: its sender and recipient, and every session a
  // waiting constraint names — resolved the same way the row renders them.
  const named: string[] = []
  const nameOf = (sessionId: string | null | undefined) => {
    if (sessionId) named.push(resolveParticipant(sessionId, sessions, []).name)
  }
  nameOf(row.fromSession)
  if (row.toKind === 'session') nameOf(row.toId)
  if (reason) {
    for (const constraint of [reason.blocker, ...reason.others]) {
      for (const sessionId of constraint.sessionIds ?? []) nameOf(sessionId)
      for (const member of constraint.members ?? []) nameOf(member.sessionId)
    }
  }
  return [
    row.fromSession ?? '', row.fromGroup ?? '',
    row.toKind === 'human' ? 'Human' : row.toId,
    ...named,
    row.body, blockerLine(row, reason),
    ...(reason?.others ?? []).map(constraint => constraintLabel(constraint)),
    ...(row.reason ? [row.reason, deadLetterLabel(row.reason)] : []),
  ].join(' ').toLowerCase()
}

export default function TeamMailboxView({ teamPath, view, sendMessage, connected, groups = [], sessions = [], onOpenSession }: {
  teamPath: string
  view: MailboxView
  sendMessage: SendClientMessage
  connected: boolean
  /** The team's group ids, suggested as hand-off targets. */
  groups?: string[]
  /** Live team sessions, for naming and linking occupants (waiting reasons). */
  sessions?: ReadonlyArray<LiveParticipant>
  /** Open a named session's chat. */
  onOpenSession?: (sessionId: string) => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])

  const tab = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.mailbox)
  const search = tab?.search ?? ''
  const hideEmpty = tab?.filters.hideEmpty === true
  const expandedRows = tab?.expanded ?? []
  const collapsedSections = tab?.collapsedSections ?? []
  // Seed the default collapsed sections once per team (the marker stays, so
  // later opens never re-collapse a section the user expanded).
  useEffect(() => {
    if (!collapsedSections.includes(DEFAULTS_APPLIED)) {
      useTeamWorkspaceStore.getState().setCollapsedSections(teamPath, 'mailbox', [DEFAULTS_APPLIED, ...DEFAULT_COLLAPSED])
    }
  }, [teamPath, collapsedSections]) // eslint-disable-line react-hooks/exhaustive-deps
  const workspace = useTeamWorkspaceStore.getState()
  const sectionCollapsed = (key: string) => collapsedSections.includes(key)
  const expanded = useMemo(() => new Set(expandedRows), [expandedRows])

  const rowsFor = (section: MailboxSection) => {
    const needle = search.trim().toLowerCase()
    return view.messages.filter(row => section.matches(row, now) &&
      (needle === '' || searchableText(row, view.waiting?.[row.id], sessions).includes(needle)))
  }

  return <div data-testid="team-mailbox" className="flex h-full min-h-0 flex-col">
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update mail.</p>}
    {view.loading && <p role="status" className="p-3">Loading mailbox…</p>}
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <input className="input max-w-64 flex-1" type="search" aria-label="Search mailbox" placeholder="Search senders, recipients, bodies, reasons"
        value={search} onChange={event => workspace.setSearch(teamPath, 'mailbox', event.target.value)} />
      <label className="flex items-center gap-1.5 text-sm text-secondary">
        <input type="checkbox" aria-label="Hide empty sections" checked={hideEmpty}
          onChange={event => workspace.setFilters(teamPath, 'mailbox', { hideEmpty: event.target.checked || undefined })} />
        Hide empty sections
      </label>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {SECTIONS.map(section => {
        const rows = rowsFor(section)
        if (hideEmpty && rows.length === 0) return null
        const collapsed = sectionCollapsed(section.key)
        return <section key={section.key} aria-label={section.key} data-mailbox-section={section.key}
          data-count={rows.length} className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <button type="button" className="btn text-sm font-medium" data-testid={`mailbox-section-toggle-${section.key}`}
              aria-expanded={!collapsed} onClick={() => workspace.toggleSectionCollapsed(teamPath, 'mailbox', section.key)}>
              {collapsed ? '▸' : '▾'} {section.key}
            </button>
            <span className="text-sm text-secondary" data-testid={`mailbox-section-count-${section.key}`}>
              {rows.length === 1 ? '1 message' : `${rows.length} messages`}
            </span>
          </div>
          {!collapsed && (rows.length === 0
            ? <p className="text-sm text-secondary">No messages</p>
            : rows.map(row => <MailboxRow key={row.id} row={row} now={now} view={view} teamPath={teamPath}
                sendMessage={sendMessage} connected={connected} groups={groups} sessions={sessions} onOpenSession={onOpenSession}
                expanded={expanded.has(row.id)} onToggle={() => workspace.toggleExpanded(teamPath, 'mailbox', row.id)} />))}
        </section>
      })}
      <section aria-label="Routing" data-mailbox-section="Routing" className="mb-4">
        <button type="button" className="btn text-sm font-medium" data-testid="mailbox-section-toggle-Routing"
          aria-expanded={!sectionCollapsed('Routing')}
          onClick={() => workspace.toggleSectionCollapsed(teamPath, 'mailbox', 'Routing')}>
          {sectionCollapsed('Routing') ? '▸' : '▾'} Routing
        </button>
        {!sectionCollapsed('Routing') && <div className="mt-2">
          <TeamRoutingSection teamPath={teamPath} view={view} sendMessage={sendMessage} connected={connected} />
        </div>}
      </section>
    </div>
  </div>
}

/** One unsettled message: a one-line summary until expanded (5.3). */
function MailboxRow({ row, now, view, teamPath, sendMessage, connected, groups, sessions, onOpenSession, expanded, onToggle }: {
  row: TeamMessage
  now: number
  view: MailboxView
  teamPath: string
  sendMessage: SendClientMessage
  connected: boolean
  groups: string[]
  sessions: ReadonlyArray<LiveParticipant>
  onOpenSession?: (sessionId: string) => void
  expanded: boolean
  onToggle: () => void
}) {
  const reason = view.waiting?.[row.id]
  const from = `${row.fromSession ?? 'Human'}${row.fromGroup ? ` (${row.fromGroup})` : ''}`
  const to = row.toKind === 'human' ? 'Human' : `${row.toKind}: ${row.toId}`
  const age = `${Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 60000))}m ago`
  const firstLine = row.body.split('\n')[0] ?? ''
  return <article data-message-id={row.id} data-expanded={expanded ? 'true' : 'false'} className="mb-2 border border-border p-2">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-sm">
          <code className="font-mono text-xs" data-testid="message-id" title={row.id}>{row.id.slice(0, 8)}</code>
          {' '}
          <span data-testid="mailbox-row-line">{from} → {to} · {age} · {row.priority} · {blockerLine(row, reason)} · {firstLine}</span>
        </p>
        {row.deliverAt && !expanded && <p className="text-sm text-secondary">Due {new Date(row.deliverAt).toLocaleString()}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button className="btn text-sm" aria-label={`Copy message id ${row.id.slice(0, 8)}`} onClick={() => copyText(row.id)}>Copy id</button>
        <button className="btn text-sm" data-testid="mailbox-row-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
    </div>
    {expanded && <>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm" data-testid="mailbox-row-body">{row.body}</p>
      {row.deliverAt && <p className="text-sm text-secondary">Due {new Date(row.deliverAt).toLocaleString()}</p>}
      {row.state === 'spawning' && reason?.blocker.reservation && <p className="text-sm text-secondary" title={reason.blocker.reservation.worktree}>
        Starting {reason.blocker.reservation.group} on {reason.blocker.reservation.profile} in {basename(reason.blocker.reservation.worktree)}
        {' '}for {elapsedLabel(reason.blocker.reservation.startedAt, now)}
      </p>}
      {(row.state === 'queued' || row.state === 'awaiting-request' || row.state === 'spawning') && reason &&
        <WaitingReasonLines reason={reason} sessions={sessions} onOpen={onOpenSession} />}
      {row.reason && <p className="text-sm text-secondary" data-testid="dead-letter-reason">
        {deadLetterLabel(row.reason)} <span className="opacity-70">({row.reason})</span>
      </p>}
      {row.state === 'awaiting-request' && <p className="text-sm text-secondary">Waiting for the recipient’s approval or answer</p>}
      {row.state === 'uncertain' && <p className="text-sm text-secondary">Retry to {row.claimedBy} with a possible-duplicate notice, or discard.</p>}
      {row.state === 'parked' && <p className="text-sm text-secondary">
        Parked on {row.claimedBy} after a provider limit{row.parkedUntil ? `; resumes ${new Date(row.parkedUntil).toLocaleString()}` : ''}
        {row.parkCount > 1 ? ` (parked ${row.parkCount} times)` : ''}
      </p>}
      {row.handoff && <p className="text-sm text-secondary">
        Handed off from {row.handoff.fromSession} ({row.handoff.fromProfile}) after {row.handoff.progress.toolCalls} tool calls
      </p>}
      {row.state === 'parked' && <ParkedHandOff teamPath={teamPath} messageId={row.id} groups={groups} sendMessage={sendMessage}
        disabled={!connected || view.loading} {...(view.handOffResult ? { result: view.handOffResult } : {})} />}
    </>}
    <div className="mt-2 flex gap-2">
      {(row.state === 'queued' || row.state === 'awaiting-request' || row.state === 'parked') && <button className="btn" disabled={!connected || view.loading}
        onClick={() => sendMessage({ type: 'team-mailbox-cancel', teamPath, messageId: row.id })}>Cancel</button>}
      {(row.state === 'dead' || row.state === 'uncertain') && <>
        <button className="btn" disabled={!connected || view.loading} onClick={() => sendMessage({ type: 'team-mailbox-retry', teamPath, messageId: row.id })}>Retry</button>
        <button className="btn" disabled={!connected || view.loading} onClick={() => sendMessage({ type: 'team-mailbox-discard', teamPath, messageId: row.id })}>Discard</button>
      </>}
    </div>
  </article>
}

/** A named session links to its chat when it is still openable. */
function SessionName({ sessionId, sessions, onOpen }: {
  sessionId: string
  sessions: ReadonlyArray<LiveParticipant>
  onOpen?: (sessionId: string) => void
}) {
  const label = resolveParticipant(sessionId, sessions, [])
  const open = onOpen && !label.gone
  return open
    ? <button type="button" className="underline-offset-2 hover:underline" data-testid="waiting-session"
      onClick={() => onOpen!(sessionId)}>{label.name}</button>
    : <span>{label.name}{label.gone ? ' (gone)' : ''}</span>
}

/** One constraint line: the label, with named sessions linked for every kind that implicates them. */
function ConstraintLine({ constraint, sessions, onOpen }: {
  constraint: WaitingConstraint
  sessions: ReadonlyArray<LiveParticipant>
  onOpen?: (sessionId: string) => void
}) {
  // Structured member breakdown (S1): each implicated member links.
  if (constraint.members) {
    return <li className="text-sm text-secondary">
      {'No eligible member — '}
      {constraint.members.map((member, index) => <span key={member.sessionId}>
        {index > 0 ? '; ' : ''}<SessionName sessionId={member.sessionId} sessions={sessions} onOpen={onOpen} />{' '}
        {member.cause}{member.detail ? ` (${basename(member.detail)})` : ''}
      </span>)}
    </li>
  }
  if (constraint.kind === 'worktree-occupied' && constraint.detail) {
    return <li className="text-sm text-secondary">
      <span title={constraint.detail}>
        Worktree {basename(constraint.detail)} is held by{' '}
        {(constraint.sessionIds ?? []).length > 0
          ? (constraint.sessionIds ?? []).map((sessionId, index) => <span key={sessionId}>
            {index > 0 ? ', ' : ''}<SessionName sessionId={sessionId} sessions={sessions} onOpen={onOpen} />
          </span>)
          : 'a pending spawn'}
      </span>
    </li>
  }
  // Every other kind that names sessions links them too; kinds whose label
  // already embeds the names above never reach here.
  const embedsNames = constraint.kind === 'worktree-occupied' || constraint.kind === 'no-eligible-member'
  return <li className="text-sm text-secondary">
    {constraintLabel(constraint, sessionId => (embedsNames ? sessionId : resolveParticipant(sessionId, sessions, []).name))}
    {!embedsNames && (constraint.sessionIds ?? []).length > 0 && <>{' '}
      {(constraint.sessionIds ?? []).map((sessionId, index) => <span key={sessionId}>
        {index > 0 ? ', ' : ''}<SessionName sessionId={sessionId} sessions={sessions} onOpen={onOpen} />
      </span>)}
    </>}
  </li>
}

/** Blocker on one line; the other constraints sit behind an expander. */
function WaitingReasonLines({ reason, sessions, onOpen }: {
  reason: WaitingReason
  sessions: ReadonlyArray<LiveParticipant>
  onOpen?: (sessionId: string) => void
}) {
  return <div data-testid="waiting-reason" className="mt-1">
    <ConstraintLine constraint={reason.blocker} sessions={sessions} onOpen={onOpen} />
    {reason.others.length > 0 && <details data-testid="waiting-others" className="text-secondary">
      <summary className="cursor-pointer select-none text-sm">Also waiting on…</summary>
      <ul className="mt-1 list-disc pl-4">
        {reason.others.map((constraint, index) => <ConstraintLine key={index} constraint={constraint} sessions={sessions} onOpen={onOpen} />)}
      </ul>
    </details>}
  </div>
}
