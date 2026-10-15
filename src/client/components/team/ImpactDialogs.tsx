// The impact review's two owner dialogs (strategy-revision-impact D9). Decide
// records one disposition for an affected plan: a disposition radio, a
// required rationale (at most 2,000 characters, never cut), and **Use
// proposal**, which fills both in from the newest proposal and sends its id —
// changing the disposition afterwards drops the id, editing only the
// rationale keeps it. Ask to assess sends one human message to a group,
// preselecting `lead` when the team defines it. Decide pins the effective
// decision it showed on open as the expected predecessor, so a decision
// recorded meanwhile refuses it as stale. Each dialog arms one command
// id when it opens (strategyStore.armImpact) and sends through
// `impactCommand`, so a resend after a lost result replays on the server.
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import {
  IMPACT_DISPOSITIONS, IMPACT_DISPOSITION_HINTS, IMPACT_DISPOSITION_LABELS, IMPACT_RATIONALE_MAX, impactRationaleError,
  type ImpactDisposition, type ImpactPlanRow,
} from '@shared/strategyImpact'
import { useStrategyStore, type StrategyView } from '../../stores/strategyStore'
import { useTeamGroups } from '../chat/useTeamGroups'

export const decideSlot = (reviewId: string, planId: string) => `decide:${reviewId}:${planId}`
export const requestSlot = (reviewId: string) => `request:${reviewId}`

interface DialogProps {
  teamPath: string
  view: StrategyView
  connected: boolean
  sendMessage: SendClientMessage
  onClose: () => void
}

/** Send one keyed impact command from `slot`: the armed id unless the payload changed. */
function sendImpact(teamPath: string, slot: string, action: 'decide' | 'request', payload: Record<string, unknown>,
  build: (ids: { requestId: string; commandId: string }) => Parameters<SendClientMessage>[0], sendMessage: SendClientMessage) {
  const store = useStrategyStore.getState()
  const requestId = crypto.randomUUID()
  const commandId = store.impactCommand(teamPath, slot, JSON.stringify(payload), requestId)
  store.begin(teamPath, requestId, action)
  sendMessage(build({ requestId, commandId }))
}

/** The dialog's own refusal, if the last refused impact command came from it. */
const slotError = (view: StrategyView, slot: string) => view.impactError?.slot === slot ? view.impactError.message : null
const busyWith = (view: StrategyView, action: 'decide' | 'request') => Object.values(view.pending).includes(action)

/** Arm the dialog's command on open; close once a success retired it. */
function useArmedDialog(teamPath: string, view: StrategyView, slot: string, onClose: () => void) {
  const seen = useRef(false)
  useEffect(() => { useStrategyStore.getState().armImpact(teamPath, slot) }, [teamPath, slot])
  const armed = view.impactCommands[slot] !== undefined
  useEffect(() => {
    if (armed) seen.current = true
    else if (seen.current) onClose()
  }, [armed, onClose])
}

export function DecideDialog({ teamPath, view, connected, sendMessage, onClose, reviewId, row }: DialogProps & { reviewId: string; row: ImpactPlanRow }) {
  const slot = decideSlot(reviewId, row.planId)
  useArmedDialog(teamPath, view, slot, onClose)
  const [disposition, setDisposition] = useState<ImpactDisposition | null>(null)
  const [rationale, setRationale] = useState('')
  const [proposalId, setProposalId] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  // The predecessor is the effective decision this dialog showed when it opened (D4 step 6):
  // a decision recorded meanwhile makes this one stale, refused inline — never silently replaced.
  const [shown] = useState(() => row.effectiveDecision)
  const proposal = row.latestProposal
  const rationaleError = impactRationaleError(rationale)
  const busy = busyWith(view, 'decide')
  const error = slotError(view, slot)
  const choose = (next: ImpactDisposition) => {
    setDisposition(next)
    // A proposal of another disposition would be refused (D4 step 5): drop it where the owner sees the change.
    if (proposal && next !== proposal.disposition) setProposalId(null)
  }
  const useProposal = () => {
    if (!proposal) return
    setDisposition(proposal.disposition)
    setRationale(proposal.rationale)
    setProposalId(proposal.id)
  }
  const submit = () => {
    setTouched(true)
    if (!disposition || rationaleError) return
    const payload = { reviewId, planId: row.planId, disposition, rationale, proposalId, expectedDecisionId: shown?.id ?? null }
    sendImpact(teamPath, slot, 'decide', payload, ids => ({
      type: 'strategy-impact-decide', teamPath, ...ids, reviewId, planId: row.planId, disposition, rationale,
      expectedDecisionId: payload.expectedDecisionId, ...(proposalId ? { proposalId } : {}),
    }), sendMessage)
  }
  const titleId = `impact-decide-title-${row.planId}`
  const firstRadio = useRef<HTMLInputElement>(null)
  useEffect(() => { firstRadio.current?.focus() }, [])
  return <div role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="impact-decide-dialog" className="mt-2 border border-border p-2"
    onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <h6 id={titleId} className="font-medium">Decide: {row.title}</h6>
    <p className="text-chat-meta text-secondary" data-testid="impact-decide-replaces">
      {shown ? `Replaces the effective decision: ${IMPACT_DISPOSITION_LABELS[shown.disposition]} — ${shown.rationale}` : 'No decision recorded yet.'}
    </p>
    {proposal && <div className="mt-1 text-chat-meta text-secondary" data-testid="impact-proposal-offer">
      Newest proposal: {IMPACT_DISPOSITION_LABELS[proposal.disposition]} — {proposal.rationale}{' '}
      <button type="button" className="btn text-chat-meta" disabled={!connected} data-testid="impact-use-proposal" onClick={useProposal}>Use proposal</button>
    </div>}
    <fieldset className="mt-2">
      <legend className="text-chat-meta">Disposition</legend>
      {IMPACT_DISPOSITIONS.map((entry, index) => <label key={entry} className="mr-3 inline-flex items-center gap-1 text-chat-body">
        <input ref={index === 0 ? firstRadio : undefined} type="radio" name={`disposition-${row.planId}`} value={entry}
          checked={disposition === entry} onChange={() => choose(entry)} data-testid={`impact-disposition-${entry}`} />
        {IMPACT_DISPOSITION_LABELS[entry]}
      </label>)}
      {disposition && <p className="text-chat-meta text-secondary">{IMPACT_DISPOSITION_HINTS[disposition]}</p>}
    </fieldset>
    <label className="mt-2 block text-chat-meta">
      Rationale (required, at most {IMPACT_RATIONALE_MAX.toLocaleString('en-US')} characters)
      <textarea className="mt-1 block w-full border border-border p-1 text-chat-body" rows={3} value={rationale}
        data-testid="impact-rationale" aria-invalid={touched && rationaleError !== null} onChange={event => setRationale(event.target.value)} />
    </label>
    {proposalId && <p className="text-chat-meta text-secondary" data-testid="impact-proposal-used">Recording the proposal (edited rationale kept).</p>}
    {touched && !disposition && <p role="alert" className="text-chat-meta text-chat-danger">Choose a disposition.</p>}
    {touched && rationaleError && <p role="alert" className="text-chat-meta text-chat-danger" data-testid="impact-rationale-error">{rationaleError}</p>}
    {error && <p role="alert" className="text-chat-meta text-chat-danger" data-testid="impact-decide-error">{error}</p>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn btn-primary text-chat-meta" disabled={!connected || busy} data-testid="impact-decide-confirm" onClick={submit}>Record decision</button>
      <button type="button" className="btn text-chat-meta" onClick={onClose}>Cancel</button>
    </div>
    {!connected && <p className="text-chat-meta text-secondary">Disconnected — reconnect to decide.</p>}
  </div>
}

export function AskDialog({ teamPath, view, connected, sendMessage, onClose, reviewId }: DialogProps & { reviewId: string }) {
  const slot = requestSlot(reviewId)
  useArmedDialog(teamPath, view, slot, onClose)
  const { groups } = useTeamGroups(connected, teamPath)
  const [group, setGroup] = useState('')
  // Preselect `lead` when the team defines it (D8); no group name is assumed otherwise.
  useEffect(() => {
    if (group === '' && groups.length > 0) setGroup(groups.some(entry => entry.id === 'lead') ? 'lead' : groups[0]!.id)
  }, [groups, group])
  const busy = busyWith(view, 'request')
  const error = slotError(view, slot)
  const select = useRef<HTMLSelectElement>(null)
  useEffect(() => { select.current?.focus() }, [])
  const submit = () => {
    if (!group) return
    sendImpact(teamPath, slot, 'request', { reviewId, group }, ids => ({ type: 'strategy-impact-request', teamPath, ...ids, reviewId, group }), sendMessage)
  }
  return <div role="dialog" aria-modal="false" aria-labelledby="impact-ask-title" data-testid="impact-ask-dialog" className="mt-2 border border-border p-2"
    onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <h6 id="impact-ask-title" className="font-medium">Ask to assess</h6>
    <p className="text-chat-meta text-secondary">Sends one message to the group, naming this review and each affected plan, asking for one proposed disposition per plan. Proposals change nothing until you decide.</p>
    <label className="mt-2 block text-chat-meta">
      Group
      <select ref={select} className="ml-2 border border-border p-1 text-chat-body" value={group} data-testid="impact-ask-group"
        onChange={event => setGroup(event.target.value)}>
        {groups.length === 0 && <option value="">(no groups)</option>}
        {groups.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-chat-meta text-chat-danger" data-testid="impact-ask-error">{error}</p>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn btn-primary text-chat-meta" disabled={!connected || busy || !group} data-testid="impact-ask-confirm" onClick={submit}>Send request</button>
      <button type="button" className="btn text-chat-meta" onClick={onClose}>Cancel</button>
    </div>
    {!connected && <p className="text-chat-meta text-secondary">Disconnected — reconnect to ask.</p>}
  </div>
}
