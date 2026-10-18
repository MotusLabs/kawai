// The Start dialog (plan-execution D17): opening it asks the server for the
// standing (`team-plan-execution-preview`), whose failing preconditions and
// messages render before anything can start — the landing mode's facts ride
// the same read. The Start command is armed per payload; a refusal keeps the
// dialog open with the named failures.
import { useEffect, useState } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

const EMPTY_FAILURES: Array<{ name: string; message: string }> = []

export default function PlanExecutionStartDialog({ teamPath, planId, revision, contentHash, connected, onSend }: {
  teamPath: string
  planId: string
  revision: number
  contentHash: string
  connected: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const slot = `start:${planId}:${revision}`
  const standingKey = `${planId}:${revision}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  // Primitive selectors only: an object selector re-renders every store tick.
  const busy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('start'))
  const failures = useTeamPlanStore(state => state.views[teamPath]?.failures) ?? EMPTY_FAILURES
  const standing = useTeamPlanStore(state => state.views[teamPath]?.standings[standingKey])

  useEffect(() => { if (open && armed === undefined) setOpen(false) }, [open, armed])

  const arm = () => {
    useTeamPlanStore.getState().arm(teamPath, slot)
    // The standing is the server's, fetched as the dialog opens (15.4): the
    // same pre-reads Start itself runs, with no write.
    const requestId = crypto.randomUUID()
    useTeamPlanStore.getState().beginPreview(teamPath, requestId, standingKey)
    onSend({ type: 'team-plan-execution-preview', teamPath, requestId, planId, revision })
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

  const serverReady = standing !== undefined && standing.state === 'standing' && standing.ready
  const standingNode = (() => {
    if (standing === undefined || standing.state === 'pending') {
      return <p className="text-chat-meta text-secondary" data-testid="plan-execution-preview-pending">Checking the standing…</p>
    }
    if (standing.state === 'error') {
      return <p className="text-chat-meta" data-testid="plan-execution-preview-error">{standing.error}</p>
    }
    if (standing.ready) {
      return <p className="text-chat-meta text-secondary" data-testid="plan-execution-start-ready">Ready to start.</p>
    }
    return <div className="text-chat-meta" data-testid="plan-execution-start-failures">
      <p>Not ready:</p>
      {standing.failures.map(failure => <p key={failure.name}>· {failure.name}: {failure.message}</p>)}
    </div>
  })()
  return <>
    <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={arm} data-testid="plan-execution-start-button">Start…</button>
    {open && <div className="mt-2 border border-border p-2" data-testid="plan-execution-start-dialog">
      <p className="font-medium">Start an execution of revision {revision}</p>
      {standingNode}
      {failures.length > 0 && <div className="text-chat-meta" data-testid="plan-execution-start-refused">
        <p>Start was refused:</p>
        {failures.map(failure => <p key={failure.name}>· {failure.name}: {failure.message}</p>)}
      </div>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy || !serverReady} onClick={send} data-testid="plan-execution-start-confirm">Start</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>}
  </>
}
