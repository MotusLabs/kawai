// Routing rules and decisions in the mailbox panel (profile routing): the
// Reload routing rules action with each rule's load result (errors inline),
// and the latest routing decisions for this team. Rules change only through
// this reload, never by editing files alone.
import type { SendClientMessage } from '@shared/types'
import type { MailboxView } from '../../stores/teamMailboxStore'
import { useTeamMailboxStore } from '../../stores/teamMailboxStore'

/** Decisions shown; the server keeps more. */
export const SHOWN_DECISIONS = 15

const CHANGE_LABELS = { added: 'new', changed: 'changed', removed: 'removed', unchanged: 'unchanged' } as const

export default function TeamRoutingSection({ sessionId, view, sendMessage, connected }: {
  sessionId: string; view: MailboxView; sendMessage: SendClientMessage; connected: boolean
}) {
  const report = view.rulesResult?.ok ? view.rulesResult.report : view.routing?.rules ?? null
  const reload = () => {
    useTeamMailboxStore.getState().beginReload(sessionId)
    sendMessage({ type: 'team-mailbox-reload-rules', sessionId })
  }
  const decisions = (view.routing?.decisions ?? []).slice(0, SHOWN_DECISIONS)
  return <>
    <section aria-label="Routing rules" className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="font-medium">Routing rules</h4>
        <button className="btn" disabled={!connected || view.loading || view.reloading} onClick={reload}>
          {view.reloading ? 'Reloading…' : 'Reload routing rules'}
        </button>
      </div>
      {view.rulesResult && !view.rulesResult.ok && <p role="alert" className="text-chat-meta text-red-400">{view.rulesResult.error}</p>}
      {!report && <p className="text-chat-meta text-secondary">Not loaded yet</p>}
      {report && <>
        <p className="text-chat-meta text-secondary">Loaded {new Date(report.loadedAt).toLocaleString()} from {report.dir}</p>
        {report.rules.length === 0 && <p className="text-chat-meta text-secondary">No rules: every group uses its built-in strategy</p>}
        <ul>
          {report.rules.map(rule => <li key={rule.groupId} data-rule-group={rule.groupId} className="text-chat-meta">
            <span className="font-medium">{rule.groupId}</span>{' '}
            {rule.change === 'removed' ? 'removed' : rule.ok ? 'loaded' : 'failed'}
            {rule.change !== 'unchanged' && rule.change !== 'removed' && ` (${CHANGE_LABELS[rule.change]})`}
            {rule.env && rule.env.length > 0 && ` · env ${rule.env.join(', ')}`}
            {rule.error && <span role="alert" className="block break-words text-red-400">{rule.error}</span>}
          </li>)}
        </ul>
      </>}
    </section>
    <section aria-label="Routing decisions" className="mb-4">
      <h4 className="mb-2 font-medium">Routing decisions</h4>
      {decisions.length === 0 && <p className="text-chat-meta text-secondary">No decisions yet</p>}
      <ul>
        {decisions.map(entry => <li key={`${entry.at}-${entry.messageId}-${entry.decision}`} className="text-chat-meta">
          <span className="text-secondary">{new Date(entry.at).toLocaleTimeString()}</span>{' '}
          {entry.groupId}: {entry.decision} <span className="text-secondary">({entry.source})</span>
          {entry.reason && <span className="block break-words text-secondary">{entry.reason}</span>}
        </li>)}
      </ul>
    </section>
  </>
}
