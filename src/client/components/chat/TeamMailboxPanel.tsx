// Human mailbox controls operate on durable rows, with authoritative server
// snapshots after each action. Uncertain retries retain the original recipient.
// Profile routing adds parked work (with Hand off), the routing rules and
// their reload, and the routing decision log. Waiting reasons
// (team-waiting-reasons): every unsettled state has a section — `spawning`
// rows render as Starting agent with their reservation's facts — and each
// waiting row shows its immediate blocker on one line with the other
// constraints expandable; dead letters read as sentences with the code
// visible. Named sessions link to their chats; worktrees show their basename
// with the full path available.
import { useEffect, useState } from 'react'
import type { LiveParticipant } from '@shared/participants'
import { resolveParticipant } from '@shared/participants'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '@shared/team'
import type { SendClientMessage } from '@shared/types'
import type { MailboxView } from '../../stores/teamMailboxStore'
import { constraintLabel, deadLetterLabel, elapsedLabel } from '../../utils/waitingLabels'
import ParkedHandOff from './ParkedHandOff'
import TeamRoutingSection from './TeamRoutingSection'

const basename = (worktree: string): string => worktree.split('/').filter(Boolean).at(-1) ?? worktree

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
    return <li className="text-chat-meta">
      {'No eligible member — '}
      {constraint.members.map((member, index) => <span key={member.sessionId}>
        {index > 0 ? '; ' : ''}<SessionName sessionId={member.sessionId} sessions={sessions} onOpen={onOpen} />{' '}
        {member.cause}{member.detail ? ` (${basename(member.detail)})` : ''}
      </span>)}
    </li>
  }
  if (constraint.kind === 'worktree-occupied' && constraint.detail) {
    return <li className="text-chat-meta">
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
  return <li className="text-chat-meta">
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
  return <div data-testid="waiting-reason">
    <ConstraintLine constraint={reason.blocker} sessions={sessions} onOpen={onOpen} />
    {reason.others.length > 0 && <details data-testid="waiting-others" className="text-secondary">
      <summary className="cursor-pointer select-none text-chat-meta">Also waiting on…</summary>
      <ul className="mt-1 list-disc pl-4">
        {reason.others.map((constraint, index) => <ConstraintLine key={index} constraint={constraint} sessions={sessions} onOpen={onOpen} />)}
      </ul>
    </details>}
  </div>
}

export default function TeamMailboxPanel({ sessionId, view, sendMessage, connected, onClose, groups = [], sessions = [], onOpenSession }: {
  sessionId: string; view: MailboxView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
  /** The team's group ids, suggested as hand-off targets. */
  groups?: string[]
  /** Live team sessions, for naming and linking occupants (waiting reasons). */
  sessions?: ReadonlyArray<LiveParticipant>
  /** Open a named session's chat. */
  onOpenSession?: (sessionId: string) => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const categories: Array<[string, (message: TeamMessage) => boolean]> = [
    ['Queued', row => (row.state === 'queued' && (!row.deliverAt || Date.parse(row.deliverAt) <= now)) || row.state === 'awaiting-request'],
    ['Starting agent', row => row.state === 'spawning'],
    ['Receiving', row => row.state === 'claimed'],
    ['Parked', row => row.state === 'parked'],
    ['Scheduled', row => row.state === 'queued' && !!row.deliverAt && Date.parse(row.deliverAt) > now],
    ['Dead letters', row => row.state === 'dead'],
    ['Held for review', row => row.state === 'uncertain'],
  ]
  return <aside data-testid="team-mailbox" className="flex min-h-0 w-full flex-col border-l border-border md:w-96">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Team mailbox</h3>
      <button className="btn" onClick={onClose}>Close mailbox</button></header>
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update mail.</p>}
    {view.loading && <p role="status" className="p-3">Loading mailbox…</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <TeamRoutingSection sessionId={sessionId} view={view} sendMessage={sendMessage} connected={connected} />
      {categories.map(([label, matches]) => <section key={label} aria-label={label} className="mb-4">
        <h4 className="mb-2 font-medium">{label}</h4>
        {view.messages.filter(matches).length === 0 && <p className="text-chat-meta text-secondary">No messages</p>}
        {view.messages.filter(matches).map(row => <article key={row.id} data-message-id={row.id} className="mb-2 border border-border p-2">
          <p className="break-all text-chat-meta">{row.fromSession}{row.fromGroup ? ` (${row.fromGroup})` : ''} → {row.toKind}: {row.toId}</p>
          <p className="text-chat-meta text-secondary">{row.priority} · {Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 60000))}m ago</p>
          {row.deliverAt && <p className="text-chat-meta">Due {new Date(row.deliverAt).toLocaleString()}</p>}
          <p className="whitespace-pre-wrap break-words text-chat-body">{row.body}</p>
          {row.state === 'spawning' && view.waiting?.[row.id]?.blocker.reservation && <p className="text-chat-meta" title={view.waiting[row.id]!.blocker.reservation!.worktree}>
            Starting {view.waiting[row.id]!.blocker.reservation!.group} on {view.waiting[row.id]!.blocker.reservation!.profile} in {basename(view.waiting[row.id]!.blocker.reservation!.worktree)}
            {' '}for {elapsedLabel(view.waiting[row.id]!.blocker.reservation!.startedAt, now)}
          </p>}
          {(row.state === 'queued' || row.state === 'awaiting-request' || row.state === 'spawning') && view.waiting?.[row.id] &&
            <WaitingReasonLines reason={view.waiting[row.id]!} sessions={sessions} onOpen={onOpenSession} />}
          {row.reason && <p className="text-chat-meta text-secondary" data-testid="dead-letter-reason">
            {deadLetterLabel(row.reason)} <span className="opacity-70">({row.reason})</span>
          </p>}
          {row.state === 'awaiting-request' && <p className="text-chat-meta">Waiting for the recipient’s approval or answer</p>}
          {row.state === 'uncertain' && <p className="text-chat-meta">Retry to {row.claimedBy} with a possible-duplicate notice, or discard.</p>}
          {row.state === 'parked' && <p className="text-chat-meta">
            Parked on {row.claimedBy} after a provider limit{row.parkedUntil ? `; resumes ${new Date(row.parkedUntil).toLocaleString()}` : ''}
            {row.parkCount > 1 ? ` (parked ${row.parkCount} times)` : ''}
          </p>}
          {row.handoff && <p className="text-chat-meta text-secondary">
            Handed off from {row.handoff.fromSession} ({row.handoff.fromProfile}) after {row.handoff.progress.toolCalls} tool calls
          </p>}
          {row.state === 'parked' && <ParkedHandOff sessionId={sessionId} messageId={row.id} groups={groups} sendMessage={sendMessage}
            disabled={!connected || view.loading} {...(view.handOffResult ? { result: view.handOffResult } : {})} />}
          <div className="mt-2 flex gap-2">
            {(row.state === 'queued' || row.state === 'awaiting-request') && <button className="btn" disabled={!connected || view.loading}
              onClick={() => sendMessage({ type: 'team-mailbox-cancel', sessionId, messageId: row.id })}>Cancel</button>}
            {(row.state === 'dead' || row.state === 'uncertain') && <>
              <button className="btn" disabled={!connected || view.loading} onClick={() => sendMessage({ type: 'team-mailbox-retry', sessionId, messageId: row.id })}>Retry</button>
              <button className="btn" disabled={!connected || view.loading} onClick={() => sendMessage({ type: 'team-mailbox-discard', sessionId, messageId: row.id })}>Discard</button>
            </>}
          </div>
        </article>)}
      </section>)}
    </div>
  </aside>
}
