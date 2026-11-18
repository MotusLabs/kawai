// The pauses of a plan's newest execution (revision-control D6, D8, D14),
// inside its Execution section: Pause… asks the holders of an active hold's
// running changes to checkpoint and stop, and Hold… holds running changes
// from here. Each pause lists its targets — Pausing with every cause, Paused
// only once `paused_at` is recorded, or decided — with their checkpoints
// (the newest first, superseded ones behind it), the held changes with no
// active work, and those whose landing was left to settle; an undecided
// target offers the checkpoint decision dialog.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { PlanExecutionView } from '@shared/planExecution'
import type { PauseTargetView, PauseView } from '@shared/planRevisionControl'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { sendPlanCommand } from './PlanCommandDialog'
import PlanHoldCommandFrame, { deadlineIso, localDeadline } from './PlanHoldCommandFrame'
import PlanHoldDialog from './PlanHoldDialog'
import PlanCheckpointDecisionDialog, { CheckpointPackage, isPaused } from './PlanCheckpointDecisionDialog'

interface Props {
  teamPath: string
  planId: string
  execution: PlanExecutionView
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}

/** A target's state as the view reads it (UI4): Paused only with a recorded `paused_at`. */
export function targetStateLabel(target: PauseTargetView): string {
  const state = target.state
  if (state.state === 'decided') return `Decided: ${state.decision}`
  if (isPaused(target)) return `Paused since ${target.pausedAt}`
  const causes = state.state === 'pausing' ? state.causes.map(cause => cause.kind) : []
  const owner = state.state === 'pausing' && state.ownerRequired ? ' — needs your decision' : ''
  return `Pausing${causes.length > 0 ? `: ${causes.join(', ')}` : ''}${owner}`
}

export default function PlanPauseSection({ teamPath, planId, execution, connected, busy, onSend }: Props) {
  const holds = useTeamPlanStore(state => state.views[teamPath]?.detailHolds) ?? []
  const pauses = (useTeamPlanStore(state => state.views[teamPath]?.detailPauses) ?? []).filter(pause => pause.executionId === execution.id)
  const running = execution.state === 'running'
  const active = holds.filter(hold => hold.releasedAt === null)
  const inFlight = execution.changes.filter(row => row.state !== 'landed' && row.state !== 'cancelled' && row.state !== 'waiting').map(row => row.change)
  if (!running && pauses.length === 0) return null
  return <div className="mt-2" data-testid="plan-pause-section">
    {running && <div className="flex flex-wrap gap-2">
      <PlanHoldDialog teamPath={teamPath} planId={planId} changes={execution.changes.map(row => row.change)} source="execution" preset={inFlight}
        connected={connected} busy={busy} onSend={onSend} />
      {active.length > 0 && <PauseDialog teamPath={teamPath} planId={planId} holds={active.map(hold => hold.id)} connected={connected} busy={busy} onSend={onSend} />}
    </div>}
    {pauses.map(pause => <PauseEntry key={pause.id} teamPath={teamPath} planId={planId} pause={pause} connected={connected} busy={busy} onSend={onSend} />)}
  </div>
}

function PauseEntry({ teamPath, planId, pause, connected, busy, onSend }: Omit<Props, 'execution'> & { pause: PauseView }) {
  return <div className="mt-2 border-l border-border pl-2 text-chat-meta" data-testid={`plan-pause-${pause.id}`}>
    <p className="font-medium">Pause {pause.id} under hold {pause.holdId} · deadline {pause.deadline}
      {pause.deadlinePassed ? ' (passed)' : ''}{pause.closedAt ? ` · closed ${pause.closedAt}` : ''}</p>
    {pause.note && <p className="text-secondary">{pause.note}</p>}
    <ul>{pause.targets.map(target => <li key={target.change} className="mt-1" data-testid={`plan-pause-target-${target.change}`}>
      <p>{target.change} ({target.stage}){target.withdrawn ? ' · instruction withdrawn' : ''} · <span data-testid={`plan-pause-state-${target.change}`}>{targetStateLabel(target)}</span></p>
      {target.checkpoint && <CheckpointPackage checkpoint={target.checkpoint} />}
      {target.checkpoints.length > 1 && <details>
        <summary>Earlier checkpoints ({target.checkpoints.length - 1})</summary>
        {target.checkpoints.filter(entry => entry.id !== target.checkpoint?.id).reverse()
          .map(entry => <CheckpointPackage key={entry.id} checkpoint={entry} />)}
      </details>}
      <PlanCheckpointDecisionDialog teamPath={teamPath} planId={planId} pauseId={pause.id} target={target} connected={connected} busy={busy} onSend={onSend} />
    </li>)}</ul>
    {pause.noActiveWork.length > 0 && <p data-testid={`plan-pause-no-active-work-${pause.id}`}>No active work: {pause.noActiveWork.join(', ')}</p>}
    {pause.landingInProgress.length > 0 && <p>Landing left to settle: {pause.landingInProgress.join(', ')}</p>}
  </div>
}

function PauseDialog({ teamPath, planId, holds, connected, busy, onSend }: Omit<Props, 'execution'> & { holds: string[] }) {
  const [holdId, setHoldId] = useState('')
  const [deadline, setDeadline] = useState('')
  const [note, setNote] = useState('')
  const slot = `pause:${planId}`
  const iso = deadlineIso(deadline)
  const ready = holds.includes(holdId) && iso !== null
  const confirm = () => {
    const extra = note.trim() === '' ? {} : { note: note.trim() }
    sendPlanCommand(teamPath, onSend, 'pause', slot, { planId, holdId, deadline: iso, ...extra }, ({ requestId, commandId }) => ({
      type: 'team-plan-pause', teamPath, requestId, planId, holdId, deadline: iso!, commandId, ...extra,
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel="Pause…" title="Pause the held changes" confirmLabel="Pause"
    testId="plan-pause-open" connected={connected} busy={busy} ready={ready}
    onOpen={() => { setHoldId(holds[0] ?? ''); setDeadline(localDeadline(1)); setNote('') }} onConfirm={confirm}>
    <p className="text-chat-meta text-secondary">Each holder is asked to checkpoint its work and stop; a change reads Paused once its checkpoint is recorded.</p>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Hold</span>
      <select aria-label="Pause hold" className="input text-chat-body" value={holdId} disabled={!connected} onChange={event => setHoldId(event.target.value)}>
        {holds.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Pause deadline (required)</span>
      <input type="datetime-local" aria-label="Pause deadline" className="input text-chat-body" value={deadline} disabled={!connected}
        onChange={event => setDeadline(event.target.value)} />
    </label>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Note to the holders (optional)</span>
      <textarea aria-label="Pause note" className="input min-h-12 text-chat-body" value={note} disabled={!connected}
        onChange={event => setNote(event.target.value)} />
    </label>
  </PlanHoldCommandFrame>
}
