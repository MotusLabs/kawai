// One promotion in the integration panel (integration-candidates D10, D13):
// its number and branch, the step it is on, the pull request, CI on the floor
// snapshot with flaky marks, the target moves, and the outcome with its note;
// **Cancel promotion** while it runs asks for a reason and arms its own
// command (`cancel-promotion:<id>`). Every control disables while
// disconnected, and a refusal shows inline.
import { useEffect, useState } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import type { PromotionStep, PromotionView } from '@shared/planIntegration'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

const STEP_LABELS: Record<PromotionStep, string> = {
  branch: 'creating the promotion branch',
  'pull-request': 'opening the pull request',
  slot: 'waiting for the landing slot',
  held: 'waiting for the hold to release',
  'up-to-date': 'bringing it up to date',
  ci: 'CI running',
  're-read': 're-reading the target',
  merge: 'merging',
  record: 'recording the merge',
  'fast-forward': 'fast-forwarding the integration branch',
  finish: 'finishing',
}

const outcomeLabel = (promotion: PromotionView): string => {
  if (promotion.outcome === null) return 'Running'
  if (promotion.outcome === 'merged') return 'Merged'
  if (promotion.outcome === 'cancelled') return `Cancelled${promotion.cancelReason ? `: ${promotion.cancelReason}` : ''}`
  const detail = promotion.outcomeDetail?.message
  return `Failed (${promotion.outcome.slice('failed:'.length)})${typeof detail === 'string' ? `: ${detail}` : ''}`
}

export default function PlanPromotionRow({ teamPath, promotion, connected, onSend }: {
  teamPath: string
  promotion: PromotionView
  connected: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const slot = `cancel-promotion:${promotion.id}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const busy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('cancel-promotion'))
  const error = useTeamPlanStore(state => state.views[teamPath]?.error ?? null)
  const running = promotion.state === 'running'

  // Success retires the slot: the dialog closes.
  useEffect(() => { if (open && armed === undefined) { setOpen(false); setReason('') } }, [open, armed])

  const send = () => {
    const store = useTeamPlanStore.getState()
    const requestId = crypto.randomUUID()
    const trimmed = reason.trim()
    const commandId = store.command(teamPath, slot, JSON.stringify({ promotionId: promotion.id, reason: trimmed }), requestId)
    store.begin(teamPath, requestId, 'cancel-promotion')
    const message: ClientMessage = { type: 'team-plan-promotion-cancel', teamPath, requestId, promotionId: promotion.id, reason: trimmed, commandId }
    onSend(message)
  }

  const ci = promotion.ci
  return <li className="border border-border p-2" data-testid="plan-promotion-row">
    <p className="text-chat-body">
      <span className="font-medium">Promotion {promotion.number}</span>
      {' · '}<span className="break-all">{promotion.promotionBranch}</span>
      {' · '}<span data-testid="plan-promotion-outcome">{outcomeLabel(promotion)}</span>
      {running && promotion.step !== null ? ` · ${STEP_LABELS[promotion.step]}` : ''}
    </p>
    <p className="text-chat-meta text-secondary">
      from {promotion.fromSha.slice(0, 8)} into {promotion.targetBranch}
      {promotion.prUrl !== null ? <> · <a className="underline" href={promotion.prUrl} target="_blank" rel="noreferrer">PR #{promotion.prNumber}</a></> : ''}
      {promotion.moves > 0 ? ` · target moved ${promotion.moves}×` : ''}
      {promotion.mergeSha !== null ? ` · merge ${promotion.mergeSha.slice(0, 8)}${promotion.treeVerified === false ? ' (tree not verified)' : ''}` : ''}
    </p>
    {ci !== null && ci.checks.length > 0 && <p className="text-chat-meta" data-testid="plan-promotion-ci">
      CI: {ci.checks.map(check => `${check.name}${ci.flaky.includes(check.name) ? ' (flaky)' : ''}=${check.conclusion}`).join(', ')}
    </p>}
    {promotion.fastForwardNote !== null && <p className="text-chat-meta">{promotion.fastForwardNote}</p>}
    {running && !open && <button type="button" className="btn mt-1" disabled={!connected || busy}
      onClick={() => { useTeamPlanStore.getState().arm(teamPath, slot); setOpen(true) }} data-testid="plan-promotion-cancel-open">Cancel promotion…</button>}
    {running && open && <div className="mt-2 border border-border p-2" data-testid="plan-promotion-cancel-dialog">
      <p className="font-medium">Cancel promotion {promotion.number}?</p>
      <p className="text-chat-meta text-secondary">Closes its pull request and keeps the integration branch; a merge in progress settles first.</p>
      <input className="input mt-1 text-chat-body" aria-label="Cancel reason" placeholder="Reason (required)" value={reason}
        disabled={!connected} onChange={event => setReason(event.target.value)} />
      {armed?.refused && error !== null && <p className="text-chat-meta" role="alert" data-testid="plan-promotion-cancel-refused">{error} Close and reopen to try again.</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy || reason.trim() === '' || armed?.refused === true} onClick={send} data-testid="plan-promotion-cancel-confirm">Cancel promotion</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setReason('') }}>Keep running</button>
      </div>
    </div>}
  </li>
}
