// Closing and reopening a plan (durable-plans D8/D12), human only. Complete
// needs an approved revision and a stated reason while any of its changes is
// not done (the unfinished ones are named); cancel always needs a reason;
// reopen returns a closed plan to open. None of them touches linked tasks.
import type { SendClientMessage } from '@shared/types'
import type { PlanDetail } from '@shared/plans'
import PlanCommandDialog, { sendPlanCommand } from './PlanCommandDialog'

export default function PlanLifecycleControls({ teamPath, detail, sendMessage, connected, busy }: {
  teamPath: string
  detail: PlanDetail
  sendMessage: SendClientMessage
  connected: boolean
  busy: boolean
}) {
  const { plan } = detail
  if (plan.lifecycle !== 'open') {
    return <div className="mt-3 flex flex-wrap gap-2" data-testid="plan-lifecycle">
      <PlanCommandDialog teamPath={teamPath} slot={`reopen:${plan.id}`} openLabel="Reopen plan" confirmLabel="Reopen" testId="plan-reopen"
        connected={connected} busy={busy}
        onConfirm={() => sendPlanCommand(teamPath, sendMessage, 'reopen', `reopen:${plan.id}`, { planId: plan.id },
          ids => ({ type: 'team-plan-reopen', teamPath, ...ids, planId: plan.id }))}>
        <p className="text-chat-meta">The plan returns to open; its revisions, drafts, and linked tasks are unchanged.</p>
      </PlanCommandDialog>
    </div>
  }
  const unfinished = detail.progress?.changes.filter(change => change.status !== 'done').map(change => change.change) ?? []
  const finish = (outcome: 'completed' | 'cancelled') => (reason: string) => {
    const payload = { planId: plan.id, outcome, reason: reason || null }
    sendPlanCommand(teamPath, sendMessage, 'finish', `finish:${plan.id}:${outcome}`, payload,
      ids => ({ type: 'team-plan-finish', teamPath, ...ids, ...payload }))
  }
  return <div className="mt-3 flex flex-wrap gap-2" data-testid="plan-lifecycle">
    <PlanCommandDialog teamPath={teamPath} slot={`finish:${plan.id}:completed`} openLabel="Complete plan" confirmLabel="Complete" testId="plan-complete"
      connected={connected} busy={busy} disabled={plan.currentApprovedRevision === null}
      reason={{ label: 'Reason', required: unfinished.length > 0 }} onConfirm={finish('completed')}>
      {unfinished.length > 0
        ? <p className="text-chat-meta">Changes not done: {unfinished.join(', ')}. Completing anyway needs a reason.</p>
        : <p className="text-chat-meta">Every change is done.</p>}
    </PlanCommandDialog>
    <PlanCommandDialog teamPath={teamPath} slot={`finish:${plan.id}:cancelled`} openLabel="Cancel plan" confirmLabel="Cancel the plan" testId="plan-cancel"
      connected={connected} busy={busy} reason={{ label: 'Reason', required: true }} onConfirm={finish('cancelled')}>
      <p className="text-chat-meta">Linked tasks keep their status; cancel or finish them separately.</p>
    </PlanCommandDialog>
  </div>
}
