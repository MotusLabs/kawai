// The Holds section of a plan's detail (revision-control D4, D14): every
// active hold — its scope, held changes, rationale, review deadline, and
// cite — with Release and Extend, then the released ones with their reason;
// Hold… opens the place dialog. Release frees the whole hold, some of a
// changes hold's rows, or narrows a plan hold to the changes it retains.
// The holds ride the selected plan's detail message (`detailHolds`).
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { HoldView } from '@shared/planRevisionControl'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { sendPlanCommand } from './PlanCommandDialog'
import PlanHoldCommandFrame, { deadlineIso, localDeadline } from './PlanHoldCommandFrame'
import PlanHoldDialog from './PlanHoldDialog'

interface Props {
  teamPath: string
  planId: string
  changes: string[]
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}

export default function PlanHoldsSection({ teamPath, planId, changes, connected, busy, onSend }: Props) {
  const holds = useTeamPlanStore(state => state.views[teamPath]?.detailHolds) ?? []
  const active = holds.filter(hold => hold.releasedAt === null)
  const released = holds.filter(hold => hold.releasedAt !== null)
  return <section className="mt-3" data-testid="plan-holds-section">
    <h3 className="text-chat-meta font-medium">Holds</h3>
    {active.length === 0 && <p className="text-chat-meta text-secondary">No active hold.</p>}
    <ul>
      {active.map(hold => <li key={hold.id} className="mt-1 text-chat-meta" data-testid={`plan-hold-${hold.id}`}>
        <p>{holdLabel(hold)} · review by {hold.deadline}</p>
        <p className="text-secondary">{hold.rationale}{hold.cites ? ` · cites ${hold.cites.kind} ${hold.cites.id}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          <ReleaseDialog teamPath={teamPath} planId={planId} hold={hold} changes={changes} connected={connected} busy={busy} onSend={onSend} />
          <ExtendDialog teamPath={teamPath} planId={planId} hold={hold} connected={connected} busy={busy} onSend={onSend} />
        </div>
      </li>)}
    </ul>
    <PlanHoldDialog teamPath={teamPath} planId={planId} changes={changes} connected={connected} busy={busy} onSend={onSend} />
    {released.length > 0 && <details className="mt-1 text-chat-meta">
      <summary>Released holds ({released.length})</summary>
      <ul>{released.map(hold => <li key={hold.id} data-testid={`plan-hold-released-${hold.id}`}>
        {holdLabel(hold)} · released {hold.releasedAt}{hold.releaseReason ? `: ${hold.releaseReason}` : ''}
      </li>)}</ul>
    </details>}
  </section>
}

const holdLabel = (hold: HoldView): string => (hold.scope === 'plan'
  ? `Hold ${hold.id} on the whole plan`
  : `Hold ${hold.id} on ${hold.changes.join(', ')}${hold.releasedChanges.length > 0 ? ` (released: ${hold.releasedChanges.join(', ')})` : ''}`)

type DialogProps = Omit<Props, 'changes'> & { hold: HoldView }

function ReleaseDialog({ teamPath, planId, hold, changes, connected, busy, onSend }: DialogProps & { changes: string[] }) {
  const [mode, setMode] = useState<'whole' | 'some'>('whole')
  const [picked, setPicked] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const slot = `hold-release:${hold.id}`
  // A changes hold frees some of its rows; a plan hold narrows to the changes it retains.
  const options = hold.scope === 'changes' ? hold.changes : changes
  const chosen = options.filter(change => picked.includes(change))
  const ready = reason.trim() !== '' && (mode === 'whole' || chosen.length > 0)
  const confirm = () => {
    const field = mode === 'whole' ? {} : hold.scope === 'changes' ? { changes: chosen } : { retain: chosen }
    sendPlanCommand(teamPath, onSend, 'hold-release', slot, { planId, holdId: hold.id, reason: reason.trim(), ...field }, ({ requestId, commandId }) => ({
      type: 'team-plan-hold-release', teamPath, requestId, planId, holdId: hold.id, reason: reason.trim(), commandId, ...field,
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel="Release…" title={`Release hold ${hold.id}`} confirmLabel="Release"
    testId={`plan-hold-release-${hold.id}`} connected={connected} busy={busy} ready={ready}
    onOpen={() => { setMode('whole'); setPicked([]); setReason('') }} onConfirm={confirm}>
    <fieldset className="mt-1 text-chat-meta">
      <legend>Release</legend>
      <label className="block"><input type="radio" name={`${slot}-mode`} aria-label="Release the whole hold" checked={mode === 'whole'}
        disabled={!connected} onChange={() => setMode('whole')} /> The whole hold</label>
      <label className="block"><input type="radio" name={`${slot}-mode`}
        aria-label={hold.scope === 'changes' ? 'Release some changes' : 'Narrow to some changes'} checked={mode === 'some'}
        disabled={!connected} onChange={() => setMode('some')} /> {hold.scope === 'changes' ? 'Some of its changes' : 'Narrow it to the changes still held'}</label>
      {mode === 'some' && <div className="ml-4">{options.map(change => <label key={change} className="block">
        <input type="checkbox" aria-label={`${hold.scope === 'changes' ? 'Release' : 'Keep holding'} ${change}`} checked={picked.includes(change)}
          disabled={!connected} onChange={event => setPicked(event.target.checked ? [...picked, change] : picked.filter(name => name !== change))} /> {change}
      </label>)}</div>}
    </fieldset>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Reason (required)</span>
      <textarea aria-label="Release reason" className="input min-h-12 text-chat-body" value={reason} disabled={!connected}
        onChange={event => setReason(event.target.value)} />
    </label>
  </PlanHoldCommandFrame>
}

function ExtendDialog({ teamPath, planId, hold, connected, busy, onSend }: DialogProps) {
  const [deadline, setDeadline] = useState('')
  const [reason, setReason] = useState('')
  const slot = `hold-extend:${hold.id}`
  const iso = deadlineIso(deadline)
  const confirm = () => {
    const extra = reason.trim() === '' ? {} : { reason: reason.trim() }
    sendPlanCommand(teamPath, onSend, 'hold-extend', slot, { planId, holdId: hold.id, deadline: iso, ...extra }, ({ requestId, commandId }) => ({
      type: 'team-plan-hold-extend', teamPath, requestId, planId, holdId: hold.id, deadline: iso!, commandId, ...extra,
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel="Extend…" title={`Extend hold ${hold.id}`} confirmLabel="Extend"
    testId={`plan-hold-extend-${hold.id}`} connected={connected} busy={busy} ready={iso !== null}
    onOpen={() => { setDeadline(localDeadline(2, new Date(Math.max(Date.now(), Date.parse(hold.deadline) || 0)))); setReason('') }} onConfirm={confirm}>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>New review deadline (required)</span>
      <input type="datetime-local" aria-label="Extended deadline" className="input text-chat-body" value={deadline} disabled={!connected}
        onChange={event => setDeadline(event.target.value)} />
    </label>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Reason (optional)</span>
      <textarea aria-label="Extend reason" className="input min-h-12 text-chat-body" value={reason} disabled={!connected}
        onChange={event => setReason(event.target.value)} />
    </label>
  </PlanHoldCommandFrame>
}
