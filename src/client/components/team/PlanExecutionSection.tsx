// The Execution section of a plan's detail (plan-execution D17, §15.4): the
// newest execution's header (state, outcome, base, stop reason) with one row
// per change — each change's decision cards render inline directly beneath
// its row (plan-supervision D15) — Start (fetching the server's standing)
// when nothing runs, and Stop while something does; a landed change carried
// into the target by a merged promotion is marked promoted, and an
// integration plan's branches follow (`PlanIntegrationPanel`). The newest
// execution's pauses, Pause…, and Hold… follow its rows (`PlanPauseSection`,
// revision-control D14); a checkpoint decision's Stop link lands on Stop.
// While the run holds an older revision than the plan's approved one, Apply
// revision… opens `PlanApplyRevisionDialog` (plan-revision-apply D6), and
// the revisions the run held list beneath its state, seq 1 (Start's record)
// first, each Apply with its rationale and its per-change publication rows.
// Every control disables while disconnected.
import { Fragment } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { ExecutionRevisionView } from '@shared/planRevisionControl'
import { promotedChanges } from '@shared/planIntegration'
import PlanIntegrationPanel from './PlanIntegrationPanel'
import PlanExecutionChangeRow from './PlanExecutionChangeRow'
import PlanExecutionStartDialog from './PlanExecutionStartDialog'
import PlanExecutionStopDialog from './PlanExecutionStopDialog'
import PlanDecisionCard from './PlanDecisionCard'
import PlanPauseSection from './PlanPauseSection'
import PlanApplyRevisionDialog from './PlanApplyRevisionDialog'

/** The execution's revision history (plan-revision-apply D4, D6); nothing from a server that sends none. */
function RevisionHistory({ revisions }: { revisions: ExecutionRevisionView[] }) {
  return <div className="mt-1" data-testid="plan-execution-history">
    <p className="text-chat-meta font-medium">Revision history</p>
    <ol className="mt-1 text-chat-meta">
      {revisions.map(row => <li key={row.seq} data-testid={`plan-execution-history-${row.seq}`}>
        <p>{row.seq === 1 ? `Started on revision ${row.revision}` : `Applied revision ${row.revision}`} · {row.appliedAt}</p>
        {row.rationale !== null && <p className="text-secondary">{row.rationale}</p>}
        {row.changes.length > 0 && <ul className="pl-4">
          {row.changes.map(change => <li key={change.change} data-testid={`plan-execution-history-${row.seq}-${change.change}`}>
            <code>{change.change}</code>: {change.class}{change.fields.length > 0 ? ` (${change.fields.join(', ')})` : ''}
            {change.choice !== null ? ` · ${change.choice}` : ''}
            {change.taskRevision !== null ? ` · task revision ${change.taskRevision}` : ''}
          </li>)}
        </ul>}
      </li>)}
    </ol>
  </div>
}

export default function PlanExecutionSection({ teamPath, plan, detail, connected, onSend, onOpenTask, sessions = [], busy = false, revealAnchor = null }: {
  teamPath: string
  plan: PlanSummary
  detail: PlanDetail
  connected: boolean
  onSend: SendClientMessage
  onOpenTask?: (taskId: string) => void
  sessions?: Session[]
  busy?: boolean
  /** The attention link's scroll target, when it names this detail's change or card (plan-supervision D15). */
  revealAnchor?: string | null
}) {
  const executions = detail.executions ?? []
  const newest = executions[0] ?? null
  const running = newest !== null && newest.state === 'running'
  const integration = detail.integration ?? []
  const promoted = promotedChanges(integration)
  const decisions = detail.decisions ?? []
  const openTask = onOpenTask ?? (() => undefined)
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
        {newest.revisions !== undefined && newest.revisions.length > 0 && <RevisionHistory revisions={newest.revisions} />}
        <ul className="mt-1">
          {newest.changes.map(row => <Fragment key={row.change}>
            <PlanExecutionChangeRow teamPath={teamPath} connected={connected} onSend={onSend} row={row} execution={newest} promoted={promoted.has(row.change)} onOpenTask={openTask}
              revealed={revealAnchor === `plan-change-${row.change}`} />
            {decisions.filter(entry => entry.card.change === row.change).map(cardView =>
              <PlanDecisionCard key={cardView.card.id} teamPath={teamPath} planId={plan.id} cardView={cardView} sessions={sessions}
                connected={connected} busy={busy} onSend={onSend} onOpenTask={openTask}
                revealed={revealAnchor === `decision-card-${cardView.card.id}`} />)}
          </Fragment>)}
        </ul>
        <PlanPauseSection teamPath={teamPath} planId={plan.id} execution={newest} connected={connected} busy={busy} onSend={onSend} />
        {running && approved !== null && approved.revision > newest.revision && <div className="mt-2" data-testid="plan-execution-apply">
          <p className="text-chat-meta text-secondary">Revision {approved.revision} is approved; this run holds revision {newest.revision}. Apply moves it forward in place.</p>
          <PlanApplyRevisionDialog teamPath={teamPath} execution={newest} revision={approved.revision} contentHash={approved.contentHash}
            connected={connected} busy={busy} onSend={onSend} />
        </div>}
        {running && <div className="mt-2" id="plan-execution-stop"><PlanExecutionStopDialog teamPath={teamPath} execution={newest} connected={connected} onSend={onSend} /></div>}
        {!running && approved !== null && <div className="mt-2" data-testid="plan-execution-restart">
          <p className="text-chat-meta text-secondary">Start runs the approved revision again; changes an earlier execution of this plan provisioned keep their worktrees and branches.</p>
          <PlanExecutionStartDialog teamPath={teamPath} planId={plan.id} revision={approved.revision} contentHash={approved.contentHash} connected={connected} onSend={onSend} />
        </div>}
      </div>}
    <PlanIntegrationPanel teamPath={teamPath} planId={plan.id} views={integration} executionRunning={running} connected={connected} onSend={onSend} />
  </section>
}
