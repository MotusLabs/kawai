// Human mailbox controls operate on durable rows, with authoritative server
// snapshots after each action. Uncertain retries retain the original recipient.
import { useEffect, useState } from 'react'
import type { TeamMessage } from '@shared/team'
import type { SendClientMessage } from '@shared/types'
import type { MailboxView } from '../../stores/teamMailboxStore'

export default function TeamMailboxPanel({ sessionId, view, sendMessage, connected, onClose }: {
  sessionId: string; view: MailboxView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const categories: Array<[string, (message: TeamMessage) => boolean]> = [
    ['Queued', row => (row.state === 'queued' && (!row.deliverAt || Date.parse(row.deliverAt) <= now)) || row.state === 'awaiting-request'],
    ['Receiving', row => row.state === 'claimed'],
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
      {categories.map(([label, matches]) => <section key={label} aria-label={label} className="mb-4">
        <h4 className="mb-2 font-medium">{label}</h4>
        {view.messages.filter(matches).length === 0 && <p className="text-chat-meta text-secondary">No messages</p>}
        {view.messages.filter(matches).map(row => <article key={row.id} data-message-id={row.id} className="mb-2 border border-border p-2">
          <p className="break-all text-chat-meta">{row.fromSession}{row.fromGroup ? ` (${row.fromGroup})` : ''} → {row.toKind}: {row.toId}</p>
          <p className="text-chat-meta text-secondary">{row.priority} · {Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 60000))}m ago</p>
          {row.deliverAt && <p className="text-chat-meta">Due {new Date(row.deliverAt).toLocaleString()}</p>}
          <p className="whitespace-pre-wrap break-words text-chat-body">{row.body}</p>
          {row.reason && <p className="text-chat-meta text-secondary">{row.reason}</p>}
          {row.state === 'awaiting-request' && <p className="text-chat-meta">Waiting for the recipient’s approval or answer</p>}
          {row.state === 'uncertain' && <p className="text-chat-meta">Retry to {row.claimedBy} with a possible-duplicate notice, or discard.</p>}
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
