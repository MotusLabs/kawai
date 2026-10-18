// The Stop dialog (plan-execution D17): what stopping cancels (the unlanded
// changes and their tasks) and keeps (landed work; a merge in progress
// settles first), with the required reason and the armed command.
import { useEffect, useState } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import type { PlanExecutionView } from '@shared/planExecution'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

export default function PlanExecutionStopDialog({ teamPath, execution, connected, onSend }: {
  teamPath: string
  execution: PlanExecutionView
  connected: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const slot = `stop:${execution.id}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const busy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('stop'))

  useEffect(() => { if (open && armed === undefined && reason === '') setOpen(false) }, [open, armed, reason])

  const cancels = execution.changes.filter(row => row.state !== 'landed' && row.state !== 'cancelled')
  const keeps = execution.changes.filter(row => row.state === 'landed')

  const send = () => {
    const store = useTeamPlanStore.getState()
    const requestId = crypto.randomUUID()
    const trimmed = reason.trim()
    const commandId = store.command(teamPath, slot, JSON.stringify({ executionId: execution.id, reason: trimmed }), requestId)
    store.begin(teamPath, requestId, 'stop')
    const message: ClientMessage = { type: 'team-plan-execution-stop', teamPath, requestId, executionId: execution.id, reason: trimmed, commandId }
    onSend(message)
  }

  return <>
    <button type="button" className="btn" disabled={!connected || busy} onClick={() => { useTeamPlanStore.getState().arm(teamPath, slot); setOpen(true) }} data-testid="plan-execution-stop-open">Stop…</button>
    {open && <div className="mt-2 border border-border p-2" data-testid="plan-execution-stop-dialog">
      <p className="font-medium">Stop this execution?</p>
      {cancels.length > 0 && <div className="text-chat-meta" data-testid="plan-execution-stop-cancels">
        <p>Cancels {cancels.map(row => row.change).join(', ')}; their tasks close as Kawai's.</p>
      </div>}
      {keeps.length > 0 && <div className="text-chat-meta" data-testid="plan-execution-stop-keeps">
        <p>Keeps {keeps.map(row => row.change).join(', ')} landed; a merge in progress settles first.</p>
      </div>}
      <input className="input mt-1 text-chat-body" aria-label="Stop reason" placeholder="Reason (required)" value={reason}
        disabled={!connected} onChange={event => setReason(event.target.value)} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy || reason.trim() === ''} onClick={send} data-testid="plan-execution-stop-confirm">Stop</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setReason('') }}>Cancel</button>
      </div>
    </div>}
  </>
}
