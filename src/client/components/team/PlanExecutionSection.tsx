// The Execution section of a plan's detail (plan-execution D17, §15.4): the
// newest execution's header (state, outcome, base, stop reason) with one row
// per change, Start when nothing runs, and Stop while something does. Every
// control disables while disconnected; Stop states what it cancels (the
// unlanded changes and their tasks) and what it keeps (landed work and a
// merge already running).
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { PlanExecutionView } from '@shared/planExecution'
import PlanExecutionChangeRow from './PlanExecutionChangeRow'

export default function PlanExecutionSection({ teamPath: _teamPath, plan, detail, connected, onOpenTask }: {
  teamPath: string
  plan: PlanSummary
  detail: PlanDetail
  connected: boolean
  onOpenTask?: (taskId: string) => void
}) {
  const executions = detail.executions ?? []
  const newest = executions[0] ?? null
  const running = newest !== null && newest.state === 'running'

  return <section className="mt-3" data-testid="plan-execution-section">
    <h3 className="text-chat-meta font-medium">Execution</h3>
    {newest === null
      ? <div>
        <p className="text-chat-meta text-secondary">No execution has run.</p>
        <StartHint plan={plan} detail={detail} />
      </div>
      : <div>
        <p className="text-chat-meta" data-testid="plan-execution-state">
          {running ? 'Running' : `Finished ${newest.outcome ?? ''}`}
          {' · revision '}{newest.revision}
          {newest.outcome === 'stopped' && newest.stopReason !== null ? ` · stopped: ${newest.stopReason}` : ''}
        </p>
        <ul className="mt-1">
          {newest.changes.map(row => <PlanExecutionChangeRow key={row.change} row={row} execution={newest} onOpenTask={onOpenTask ?? (() => undefined)} />)}
        </ul>
        {running && <StopListing execution={newest} connected={connected} />}
      </div>}
  </section>
}

function StartHint({ plan, detail }: { plan: PlanSummary; detail: PlanDetail }) {
  if (plan.currentApprovedRevision === null) {
    return <p className="text-chat-meta text-secondary">Start needs an approved revision.</p>
  }
  void detail
  return <p className="text-chat-meta text-secondary">Start runs the approved revision from its validated artifacts.</p>
}

function StopListing({ execution, connected }: { execution: PlanExecutionView; connected: boolean }) {
  const cancels = execution.changes.filter(row => row.state !== 'landed' && row.state !== 'cancelled')
  const keeps = execution.changes.filter(row => row.state === 'landed')
  return <div className="mt-2 border border-border p-2" data-testid="plan-execution-stop">
    <p className="text-chat-meta font-medium">Stop this execution?</p>
    {cancels.length > 0 && <div className="text-chat-meta" data-testid="stop-cancels">
      <p>Cancels: {cancels.map(row => row.change).join(', ')} — their tasks close as Kawai's.</p>
    </div>}
    {keeps.length > 0 && <div className="text-chat-meta" data-testid="stop-keeps">
      <p>Keeps: {keeps.map(row => row.change).join(', ')} already landed; a merge in progress settles first.</p>
    </div>}
    <button type="button" className="btn mt-1" disabled={!connected} data-testid="plan-execution-stop-button">Stop…</button>
  </div>
}
