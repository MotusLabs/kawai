// The Hold dialog (revision-control D4, D14): the scope — the whole plan, or
// some of its changes — the required rationale, the review deadline, and an
// optional cite (a strategy impact review or a decision card). It opens from
// the plan detail's Holds section and from the execution section (its own
// slot, so both can stand open); the payload names every field the server
// compares on replay, so editing any of them re-mints the command id.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { HoldCites, HoldScope } from '@shared/planRevisionControl'
import { sendPlanCommand } from './PlanCommandDialog'
import PlanHoldCommandFrame, { deadlineIso, localDeadline } from './PlanHoldCommandFrame'

export default function PlanHoldDialog({ teamPath, planId, changes, source = 'detail', preset = [], connected, busy, onSend }: {
  teamPath: string
  planId: string
  /** The plan's change names, in content order. */
  changes: string[]
  /** Where it opens: the execution section's dialog has its own slot. */
  source?: 'detail' | 'execution'
  /** Changes ticked when it opens (the execution section's running changes). */
  preset?: string[]
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}) {
  const [scope, setScope] = useState<HoldScope>('plan')
  const [picked, setPicked] = useState<string[]>([])
  const [rationale, setRationale] = useState('')
  const [deadline, setDeadline] = useState('')
  const [citeKind, setCiteKind] = useState<'' | HoldCites['kind']>('')
  const [citeId, setCiteId] = useState('')
  const slot = `hold-place:${planId}${source === 'execution' ? ':execution' : ''}`
  const testId = source === 'execution' ? 'plan-hold-place-execution' : 'plan-hold-place'
  const iso = deadlineIso(deadline)
  const cites: HoldCites | null = citeKind === '' ? null : { kind: citeKind, id: citeId.trim() }
  const held = changes.filter(change => picked.includes(change))
  const ready = rationale.trim() !== '' && iso !== null && (scope === 'plan' || held.length > 0) && (cites === null || cites.id !== '')
  const reset = () => {
    setScope(preset.length > 0 ? 'changes' : 'plan'); setPicked(preset); setRationale(''); setDeadline(localDeadline(2))
    setCiteKind(''); setCiteId('')
  }
  const confirm = () => {
    const payload = { planId, scope, changes: scope === 'changes' ? held : [], rationale: rationale.trim(), deadline: iso, cites }
    sendPlanCommand(teamPath, onSend, 'hold-place', slot, payload, ({ requestId, commandId }) => ({
      type: 'team-plan-hold-place', teamPath, requestId, planId, scope, rationale: rationale.trim(), deadline: iso!, cites, commandId,
      ...(scope === 'changes' ? { changes: held } : {}),
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel="Hold…" title="Hold this plan's work" confirmLabel="Hold"
    testId={testId} connected={connected} busy={busy} ready={ready} onOpen={reset} onConfirm={confirm}>
    <fieldset className="mt-1 text-chat-meta">
      <legend>Scope</legend>
      <label className="block"><input type="radio" name={`${slot}-scope`} aria-label="Whole plan" checked={scope === 'plan'} disabled={!connected}
        onChange={() => setScope('plan')} /> The whole plan</label>
      <label className="block"><input type="radio" name={`${slot}-scope`} aria-label="Some changes" checked={scope === 'changes'} disabled={!connected}
        onChange={() => setScope('changes')} /> Some changes</label>
      {scope === 'changes' && <div className="ml-4">
        {changes.map(change => <label key={change} className="block">
          <input type="checkbox" aria-label={`Hold ${change}`} checked={picked.includes(change)} disabled={!connected}
            onChange={event => setPicked(event.target.checked ? [...picked, change] : picked.filter(name => name !== change))} /> {change}
        </label>)}
      </div>}
    </fieldset>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Rationale (required)</span>
      <textarea aria-label="Hold rationale" className="input min-h-12 text-chat-body" value={rationale} disabled={!connected}
        onChange={event => setRationale(event.target.value)} />
    </label>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Review deadline (required): the deadline raises attention and never releases anything</span>
      <input type="datetime-local" aria-label="Hold deadline" className="input text-chat-body" value={deadline} disabled={!connected}
        onChange={event => setDeadline(event.target.value)} />
    </label>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Cites (optional)</span>
      <select aria-label="Hold cites" className="input text-chat-body" value={citeKind} disabled={!connected}
        onChange={event => setCiteKind(event.target.value as '' | HoldCites['kind'])}>
        <option value="">Nothing</option>
        <option value="impact-review">A strategy impact review</option>
        <option value="decision-card">A decision card</option>
      </select>
      {citeKind !== '' && <input type="text" aria-label="Cited id" className="input text-chat-body" value={citeId} disabled={!connected}
        onChange={event => setCiteId(event.target.value)} />}
    </label>
  </PlanHoldCommandFrame>
}
