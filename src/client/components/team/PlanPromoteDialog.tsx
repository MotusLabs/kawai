// The Promote dialog (integration-candidates D9, D13): opening it arms the
// Promote command (`promote:<plan>:<branch>`) and asks the server for the
// preview (`team-plan-promotion-preview`) — the standing with every failing
// entry, the head Promote would pin, the carried changes, and their outside
// commits, flagged. Promote sends that head as `fromSha`; the payload names
// it, so a changed head re-mints the command. A refusal (e.g. `no-execution`)
// shows inline and turns Confirm off until the dialog is reopened.
import { useEffect, useState } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import type { PlanIntegrationView } from '@shared/planIntegration'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

const EMPTY: Array<{ name: string; message: string }> = []

export default function PlanPromoteDialog({ teamPath, planId, view, connected, onSend }: {
  teamPath: string
  planId: string
  view: PlanIntegrationView
  connected: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const slot = `promote:${planId}:${view.branch}`
  const previewKey = `${planId}:${view.branch}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const busy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('promote'))
  const preview = useTeamPlanStore(state => state.views[teamPath]?.promotionPreviews[previewKey])
  const error = useTeamPlanStore(state => state.views[teamPath]?.error ?? null)
  const failures = useTeamPlanStore(state => state.views[teamPath]?.failures) ?? EMPTY

  // Success retires the slot: the dialog closes.
  useEffect(() => { if (open && armed === undefined) setOpen(false) }, [open, armed])

  const requestPreview = () => {
    const requestId = crypto.randomUUID()
    useTeamPlanStore.getState().beginPromotionPreview(teamPath, requestId, previewKey)
    onSend({ type: 'team-plan-promotion-preview', teamPath, requestId, planId, branch: view.branch })
  }
  const openDialog = () => {
    useTeamPlanStore.getState().arm(teamPath, slot)
    requestPreview()
    setOpen(true)
  }
  // A reconnect drops a preview whose answer was lost: ask again while open.
  useEffect(() => { if (open && connected && preview === undefined) requestPreview() }, [open, connected, preview]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = preview?.state === 'preview' ? preview.preview : null
  const fromSha = shown?.head ?? null
  const send = () => {
    if (fromSha === null) return
    const store = useTeamPlanStore.getState()
    const requestId = crypto.randomUUID()
    const commandId = store.command(teamPath, slot, JSON.stringify({ planId, branch: view.branch, fromSha }), requestId)
    store.begin(teamPath, requestId, 'promote')
    const message: ClientMessage = { type: 'team-plan-promote', teamPath, requestId, planId, branch: view.branch, fromSha, commandId }
    onSend(message)
  }

  const ready = shown !== null && shown.failures.length === 0 && fromSha !== null
  const body = (() => {
    if (preview === undefined || preview.state === 'pending') return <p className="text-chat-meta text-secondary" data-testid="plan-promote-pending">Reading the branch…</p>
    if (preview.state === 'error') return <p className="text-chat-meta" role="alert" data-testid="plan-promote-preview-error">{preview.error}</p>
    const { preview: p } = preview
    return <div className="text-chat-meta">
      <p data-testid="plan-promote-head">Pins {p.branch} at {p.head ?? 'an unreadable head'} into {p.targetBranch ?? 'the default branch'}.</p>
      {p.carried.length > 0
        ? <div data-testid="plan-promote-carried">
          <p>Carries:</p>
          <ul>{p.carried.map(candidate => <li key={candidate.id}>· {candidate.change ?? 'promotion'} (#{candidate.seq}, {candidate.commitSha.slice(0, 8)})</li>)}</ul>
        </div>
        : <p>Carries no landed change.</p>}
      {p.outside.length > 0 && <div className="mt-1" data-testid="plan-promote-outside">
        <p>⚑ Includes {p.outside.length} commit{p.outside.length === 1 ? '' : 's'} pushed outside Kawai:</p>
        <ul>{p.outside.map(commit => <li key={commit.sha}>· {commit.sha.slice(0, 8)} {commit.subject} — {commit.author}</li>)}</ul>
      </div>}
      {p.failures.length > 0 && <div className="mt-1" data-testid="plan-promote-not-ready">
        <p>Not ready:</p>
        {p.failures.map(failure => <p key={failure.name}>· {failure.name}: {failure.message}</p>)}
      </div>}
    </div>
  })()

  return <>
    <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={openDialog} data-testid="plan-promote-open">Promote to {view.targetBranch}…</button>
    {open && <div className="mt-2 border border-border p-2" data-testid="plan-promote-dialog">
      <p className="font-medium">Promote {view.branch} into {view.targetBranch}</p>
      <p className="text-chat-meta text-secondary">Merges with a merge commit through a pull request, after CI on the floor checks.</p>
      {body}
      {armed?.refused && <div className="text-chat-meta" role="alert" data-testid="plan-promote-refused">
        <p>Promote was refused{error !== null ? `: ${error}` : ''}</p>
        {failures.map(failure => <p key={failure.name}>· {failure.name}: {failure.message}</p>)}
        <p>Close and reopen to try again.</p>
      </div>}
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy || !ready || armed?.refused === true} onClick={send} data-testid="plan-promote-confirm">Promote</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>}
  </>
}
