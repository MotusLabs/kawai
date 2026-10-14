// A plan revision's ordered changes (durable-plans D12): each change's
// OpenSpec name, dependencies, implementing and effective review group,
// acceptance, extra checks, and guidance, with its derived progress, the
// dependencies it still waits on, and its linked tasks. Tasks linked to a
// change this revision no longer lists are shown apart, links unchanged.
import { effectiveReviewGroup, type PlanContent, type PlanLinkedTask, type PlanProgress } from '@shared/plans'
import { CHANGE_STATUS_LABELS } from './planLabels'
import { CheckList } from './PlanPolicySection'

const TASK_STATUS: Record<PlanLinkedTask['status'], string> = { open: 'Open', active: 'Active', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' }

export default function PlanChangesSection({ content, progress, onOpenTask }: {
  content: PlanContent
  /** Progress of the approved revision; null when the shown revision is not approved. */
  progress: PlanProgress | null
  onOpenTask?: (taskId: string) => void
}) {
  return <section data-testid="plan-changes" aria-labelledby="plan-changes-heading" className="mt-3">
    <h4 id="plan-changes-heading" className="font-medium">Changes</h4>
    {content.changes.length === 0 && <p className="text-chat-meta text-secondary">(no changes)</p>}
    <ol className="mt-1 space-y-2">
      {content.changes.map((change, index) => {
        const entry = progress?.changes.find(candidate => candidate.change === change.change)
        return <li key={change.change} className="border border-border p-2" data-testid={`plan-change-${change.change}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{index + 1}. {change.change}</span>
            {entry && <span className="text-chat-meta" data-testid="plan-change-status">{CHANGE_STATUS_LABELS[entry.status]}</span>}
          </div>
          <p className="text-chat-meta text-secondary">
            {change.dependsOn.length > 0 ? `Depends on ${change.dependsOn.join(', ')}` : 'No dependencies'}
            {' · '}group {change.group ?? '(none)'} · review {effectiveReviewGroup(content, change) ?? '(none)'}
          </p>
          {entry && entry.waitsOn.length > 0 && <p className="text-chat-meta text-approval" data-testid="plan-change-waits">Waits on {entry.waitsOn.join(', ')}</p>}
          {change.acceptance.length > 0 && <ul className="mt-1 list-disc pl-5 text-chat-body">{change.acceptance.map((rule, ruleIndex) => <li key={ruleIndex}>{rule}</li>)}</ul>}
          {change.extraChecks.length > 0 && <div className="mt-1"><span className="text-chat-meta text-secondary">Extra checks</span><CheckList checks={change.extraChecks} /></div>}
          {change.guidance && <p className="mt-1 whitespace-pre-wrap text-chat-meta text-secondary">Guidance: {change.guidance}</p>}
          {entry && <TaskList tasks={entry.tasks} onOpenTask={onOpenTask} />}
        </li>
      })}
    </ol>
    {progress && progress.outsideRevision.length > 0 && <div className="mt-2 border border-border p-2" data-testid="plan-outside-revision">
      <h5 className="text-chat-meta font-medium text-secondary">Linked tasks outside this revision</h5>
      <TaskList tasks={progress.outsideRevision} onOpenTask={onOpenTask} showChange />
    </div>}
  </section>
}

function TaskList({ tasks, onOpenTask, showChange = false }: { tasks: PlanLinkedTask[]; onOpenTask?: (taskId: string) => void; showChange?: boolean }) {
  if (tasks.length === 0) return <p className="mt-1 text-chat-meta text-secondary">No linked tasks</p>
  return <ul className="mt-1 text-chat-meta" data-testid="plan-linked-tasks">{tasks.map(task => <li key={task.id}>
    {onOpenTask
      ? <button type="button" className="underline" onClick={() => onOpenTask(task.id)}>{task.title}</button>
      : task.title}
    {' — '}{TASK_STATUS[task.status]}{showChange ? ` (change ${task.planChange})` : ''}
  </li>)}</ul>
}
