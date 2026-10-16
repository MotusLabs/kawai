// One proposal of a process report (team-process-metrics D6): the target,
// edit, rationale, and expected effects; the human's one decision (Accept or
// Reject with an optional reason) while undecided; once accepted, its
// implementation link with who made it, the shared marker, a picker over the
// link candidates (Link, or Replace link), Unlink, the link history, and the
// outcome of each expected effect. Commands go through the metrics store's
// armed keys; a refusal shows on the card. Every control disables while
// disconnected or while the card's command waits.
import { useState } from 'react'
import { METRIC_DEF_BY_ID } from '@shared/processMetrics'
import type { ProcessProposal } from '@shared/processReports'
import type { SendClientMessage } from '@shared/types'
import { useMetricsStore } from '../../../stores/metricsStore'
import { formatValue } from './metricFormat'
import { OUTCOME_LABELS, actorLabel, changeLabel, shortHash, targetLabel, timeLabel, type NameOf } from './reportLabels'

const ARROW = { up: '↑', down: '↓' } as const

export default function ProposalCard({ teamPath, proposal, position, sendMessage, connected, nameOf }: {
  teamPath: string
  proposal: ProcessProposal
  position: number
  sendMessage: SendClientMessage
  connected: boolean
  nameOf: NameOf
}) {
  const decideSlot = useMetricsStore(state => state.views[teamPath]?.commands[`decide:${proposal.id}`])
  const linkSlot = useMetricsStore(state => state.views[teamPath]?.commands[`link:${proposal.id}`])
  const [reason, setReason] = useState('')
  const [choice, setChoice] = useState('')
  const busy = !!decideSlot?.busy || !!linkSlot?.busy
  const disabled = !connected || busy

  const decide = (decision: 'accepted' | 'rejected') => {
    const payload = { decision, reason: reason.trim() || null }
    const commandId = useMetricsStore.getState().arm(teamPath, `decide:${proposal.id}`, payload)
    sendMessage({ type: 'process-proposal-decide', teamPath, proposalId: proposal.id, ...payload, commandId })
  }
  const link = (changeStartId: string | null) => {
    const commandId = useMetricsStore.getState().arm(teamPath, `link:${proposal.id}`, { changeStartId })
    sendMessage({ type: 'process-proposal-link', teamPath, proposalId: proposal.id, changeStartId, commandId })
  }
  const { decision } = proposal
  const candidates = proposal.candidates.filter(change => change.startId !== proposal.link?.changeStartId)

  return <li className="border border-border p-2" data-testid="proposal-card" data-proposal={proposal.id}>
    <div className="font-medium">
      {position}. {proposal.kind === 'revert' ? 'Revert' : 'Change'} {targetLabel(proposal.targetKind, proposal.target)}
      {proposal.revertToHash && <span className="text-secondary"> to {shortHash(proposal.revertToHash)}</span>}
    </div>
    <p className="whitespace-pre-wrap text-sm">{proposal.edit}</p>
    <p className="whitespace-pre-wrap text-sm text-secondary">{proposal.rationale}</p>
    <p className="text-chat-meta text-secondary" data-testid="proposal-expected">
      Expects {proposal.expected.map(effect => `${METRIC_DEF_BY_ID.get(effect.metric)?.label ?? effect.metric} ${ARROW[effect.direction]}`).join(', ')}
    </p>

    {!decision && <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="proposal-decide">
      <input value={reason} onChange={event => setReason(event.target.value)} disabled={disabled} placeholder="Reason (optional)"
        aria-label="Decision reason" className="min-w-0 flex-1 border border-border bg-base px-1 text-sm" />
      <button type="button" className="btn btn-primary text-sm" disabled={disabled} onClick={() => decide('accepted')}>Accept</button>
      <button type="button" className="btn text-sm" disabled={disabled} onClick={() => decide('rejected')}>Reject</button>
    </div>}
    {decision && <p className="mt-2 text-sm" data-testid="proposal-decision">
      {decision.decision === 'accepted' ? 'Accepted' : 'Rejected'} {timeLabel(decision.decidedAt)}
      {decision.reason && <> — {decision.reason}</>}
      <span className="text-secondary"> · hash at decision {shortHash(decision.targetHashAtDecision)}</span>
    </p>}
    {decideSlot?.error && <p role="alert" className="text-chat-meta text-chat-danger">{decideSlot.error}</p>}

    {decision?.decision === 'accepted' && <div className="mt-2" data-testid="proposal-link">
      {proposal.link
        ? <p className="text-sm">
            Implemented by start {proposal.link.changeStartId} ({shortHash(proposal.link.changeHash)} at {timeLabel(proposal.link.changeAt)}),
            linked by {actorLabel(proposal.link.actor, nameOf)}
            {proposal.sharedWith.length > 0 && <span className="ml-1 border border-border px-1 text-chat-meta" data-testid="proposal-shared">
              Shared with {proposal.sharedWith.length} other proposal{proposal.sharedWith.length === 1 ? '' : 's'}
            </span>}
          </p>
        : <p className="text-sm text-secondary">Not linked to an implementation yet.</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select value={choice} disabled={disabled || candidates.length === 0} aria-label="Version change" data-testid="proposal-candidates"
          className="border border-border bg-base text-sm" onChange={event => setChoice(event.target.value)}>
          <option value="">{candidates.length === 0 ? 'No qualifying version change' : 'Choose a version change…'}</option>
          {candidates.map(change => <option key={change.startId} value={change.startId}>{changeLabel(change)} · start {change.startId}</option>)}
        </select>
        <button type="button" className="btn text-sm" disabled={disabled || !choice} onClick={() => link(choice)}>
          {proposal.link ? 'Replace link' : 'Link'}
        </button>
        {proposal.link && <button type="button" className="btn text-sm" disabled={disabled} onClick={() => link(null)}>Unlink</button>}
      </div>
      {linkSlot?.error && <p role="alert" className="text-chat-meta text-chat-danger">{linkSlot.error}</p>}
      {proposal.linkHistory.length > 0 && <ul className="mt-1 text-chat-meta text-secondary" data-testid="proposal-link-history">
        {proposal.linkHistory.map((event, index) => <li key={index}>
          {event.action} {event.changeStartId ? `start ${event.changeStartId} (${shortHash(event.changeHash)})` : ''} by {actorLabel(event.actor, nameOf)} {timeLabel(event.at)}
        </li>)}
      </ul>}
    </div>}

    {proposal.outcome && <table className="mt-2 text-sm" data-testid="proposal-outcome">
      <thead><tr className="text-left text-secondary"><th>Expected</th><th>Before</th><th>After</th><th>Outcome</th></tr></thead>
      <tbody>{proposal.outcome.map((effect, index) => {
        const def = METRIC_DEF_BY_ID.get(effect.metric)
        const stat = (s: typeof effect.before) => `${def ? formatValue(s.value, def.unit) : s.value ?? '—'} (n ${s.n})`
        return <tr key={index} data-testid="proposal-outcome-row" data-state={effect.state}>
          <td className="pr-2">{def?.label ?? effect.metric} {ARROW[effect.direction]}</td>
          <td className="pr-2">{stat(effect.before)}</td>
          <td className="pr-2">{stat(effect.after)}</td>
          <td>{OUTCOME_LABELS[effect.state]}{!effect.attributed && <span className="text-secondary"> · not attributed</span>}</td>
        </tr>
      })}</tbody>
    </table>}
  </li>
}
