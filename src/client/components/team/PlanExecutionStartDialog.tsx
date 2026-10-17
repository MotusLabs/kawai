// The Start dialog (plan-execution D17): the standing's failing
// preconditions with their messages, the landing mode, base branch, floor
// map, parallel limit, and role profiles, and the Start command armed per
// payload. A refusal keeps the dialog open with the named failures.
import { useEffect, useState } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

const EMPTY_FAILURES: Array<{ name: string; message: string }> = []

export default function PlanExecutionStartDialog({ teamPath, planId, revision, contentHash, standing, connected, onSend }: {
  teamPath: string
  planId: string
  revision: number
  contentHash: string
  /** The preview's failures; empty means ready. */
  standing: Array<{ name: string; message: string }>
  connected: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const slot = `start:${planId}:${revision}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  // Primitive selectors only: an object selector re-renders every store tick.
  const busy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('start'))
  const failures = useTeamPlanStore(state => state.views[teamPath]?.failures) ?? EMPTY_FAILURES

  useEffect(() => { if (open && armed === undefined) setOpen(false) }, [open, armed])

  const arm = () => {
    useTeamPlanStore.getState().arm(teamPath, slot)
    setOpen(true)
  }

  const send = () => {
    const store = useTeamPlanStore.getState()
    const requestId = crypto.randomUUID()
    const payload = JSON.stringify({ planId, revision, contentHash })
    const commandId = store.command(teamPath, slot, payload, requestId)
    store.begin(teamPath, requestId, 'start')
    const message: ClientMessage = { type: 'team-plan-execution-start', teamPath, requestId, planId, revision, contentHash, commandId }
    onSend(message)
  }

  const shown = failures.length > 0 ? failures : standing
  return <>
    <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={arm} data-testid="plan-execution-start-button">Start…</button>
    {open && <div className="mt-2 border border-border p-2" data-testid="plan-execution-start-dialog">
      <p className="font-medium">Start an execution of revision {revision}</p>
      {shown.length > 0
        ? <div className="text-chat-meta" data-testid="plan-execution-start-failures">
          <p>Not ready:</p>
          {shown.map(failure => <p key={failure.name}>· {failure.name}: {failure.message}</p>)}
        </div>
        : <p className="text-chat-meta text-secondary" data-testid="plan-execution-start-ready">Ready to start.</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy || shown.length > 0} onClick={send} data-testid="plan-execution-start-confirm">Start</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>}
  </>
}
