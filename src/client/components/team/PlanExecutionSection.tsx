// The Execution section of a plan's detail (plan-execution D17, §15.4): the
// newest execution's header (state, outcome, base, stop reason) with one row
// per change, Start (fetching the server's standing) when nothing runs, and
// Stop while something does; a landed change carried into the target by a
// merged promotion is marked promoted, and an integration plan's branches
// follow (`PlanIntegrationPanel`). Every control disables while disconnected.
import type { SendClientMessage } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import { promotedChanges } from '@shared/planIntegration'
import PlanIntegrationPanel from './PlanIntegrationPanel'
import PlanExecutionChangeRow from './PlanExecutionChangeRow'
import PlanExecutionStartDialog from './PlanExecutionStartDialog'
import PlanExecutionStopDialog from './PlanExecutionStopDialog'

export default function PlanExecutionSection({ teamPath, plan, detail, connected, onSend, onOpenTask }: {
  teamPath: string
  plan: PlanSummary
  detail: PlanDetail
  connected: boolean
  onSend: SendClientMessage
  onOpenTask?: (taskId: string) => void
}) {
  const executions = detail.executions ?? []
  const newest = executions[0] ?? null
  const running = newest !== null && newest.state === 'running'
  const integration = detail.integration ?? []
  const promoted = promotedChanges(integration)
  const approved = plan.currentApprovedRevision === null
    ? null
    : detail.revisions.find(row => row.revision === plan.currentApprovedRevision) ?? null

  return <section className="mt-3" data-testid="plan-execution-section">
    <h3 className="text-chat-meta font-medium">Execution</h3>
    {newest === null
      ? <div>
        <p className="text-chat-meta text-secondary">No execution has run.</p>
        {approved === null
          ? <p className="text-chat-meta text-secondary">Start needs an approved revision.</p>
          : <div>
            <p className="text-chat-meta text-secondary">Start runs the approved revision from its validated artifacts.</p>
            <PlanExecutionStartDialog teamPath={teamPath} planId={plan.id} revision={approved.revision} contentHash={approved.contentHash} connected={connected} onSend={onSend} />
          </div>}
      </div>
      : <div>
        <p className="text-chat-meta" data-testid="plan-execution-state">
          {running ? 'Running' : `Finished ${newest.outcome ?? ''}`}
          {' · revision '}{newest.revision}
          {newest.outcome === 'stopped' && newest.stopReason !== null ? ` · stopped: ${newest.stopReason}` : ''}
        </p>
        <ul className="mt-1">
          {newest.changes.map(row => <PlanExecutionChangeRow key={row.change} row={row} execution={newest} promoted={promoted.has(row.change)} onOpenTask={onOpenTask ?? (() => undefined)} />)}
        </ul>
        {running && <div className="mt-2"><PlanExecutionStopDialog teamPath={teamPath} execution={newest} connected={connected} onSend={onSend} /></div>}
      </div>}
    <PlanIntegrationPanel teamPath={teamPath} planId={plan.id} views={integration} executionRunning={running} connected={connected} onSend={onSend} />
  </section>
}
