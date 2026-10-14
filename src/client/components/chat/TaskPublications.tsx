// Publication detail per published revision (task-revision-publication 5.3,
// D4/D5): rationale and author, then per assignment holder three separate
// facts — the notice state (Not notified, Queued, Delivered, Failed with its
// reason, Uncertain), the delivered revision, and the acknowledged revision.
// Receipt is not acknowledgement, so they are never merged into one label.
// **Notify** reaches holders without a notice; **Retry notification** resends
// after a failure — one keyed command, never a new revision. Uncertain
// notices are the mailbox's to resolve (Retry or Discard), so they link there.
import type { Session } from '@shared/types'
import type { RevisionRecipient, TaskAcknowledgement, TaskPublication, TeamTaskSummary } from '@shared/teamTasks'
import type { TaskActFn } from './TaskDirectionEditor'
import { actorLabel, sessionLabel } from './teamTaskLabels'

const NOTICE_LABELS: Record<RevisionRecipient['noticeState'], string> = {
  'not-notified': 'Not notified', queued: 'Queued', delivered: 'Delivered', failed: 'Failed', uncertain: 'Uncertain',
}

export function noticeLabel(recipient: RevisionRecipient): string {
  const label = NOTICE_LABELS[recipient.noticeState]
  return recipient.noticeState === 'failed' && recipient.reason ? `${label} (${recipient.reason})` : label
}

export default function TaskPublications({ task, publications, acknowledgements, sessions, disabled, act, onOpenMailbox }: {
  task: TeamTaskSummary
  publications: TaskPublication[]
  acknowledgements: TaskAcknowledgement[]
  sessions: Session[]
  disabled: boolean
  act: TaskActFn
  /** Open the team mailbox, where an uncertain notice is retried or discarded. */
  onOpenMailbox?: () => void
}) {
  if (publications.length === 0) return null
  // Notify and Retry notification are separate intents with their own keys: a
  // Retry after a lost Notify result must not replay that Notify (which sent
  // the notice that failed). A double click of either still reuses its key.
  const notify = (revision: number, intent: 'notify' | 'retry') => act('notify', { type: 'team-task-notify', revision },
    { slot: `notify:${task.id}:${revision}`, payload: intent })
  return <section aria-label="Publications" className="mt-3" data-testid="task-publications">
    <h5 className="font-medium">Publications</h5>
    {[...publications].reverse().map(publication => {
      const missing = publication.recipients.some(recipient => recipient.noticeState === 'not-notified')
      const failed = publication.recipients.some(recipient => recipient.noticeState === 'failed')
      return <article key={publication.revision} className="mt-2 border border-border p-2" data-testid="task-publication" data-revision={publication.revision}>
        <p className="text-chat-meta text-secondary">Revision {publication.revision} · published by {actorLabel(publication.author, sessions)} · {new Date(publication.publishedAt).toLocaleString()}
          {publication.notify === null ? ' · published before notifications' : ''}</p>
        <p className="text-chat-body" data-testid="task-publication-rationale">{publication.rationale ?? 'No rationale given'}</p>
        {publication.recipients.length === 0
          ? <p className="text-chat-meta text-secondary">No claimed agent holds the assignment; a queued instruction carries the current revision when delivered.</p>
          : publication.recipients.map(recipient => <p key={recipient.sessionId} className="text-chat-meta" data-testid="task-publication-recipient"
            data-session-id={recipient.sessionId} data-notice-state={recipient.noticeState}>
            {sessionLabel(recipient.sessionId, sessions)} · <span data-testid="recipient-notice">{noticeLabel(recipient)}</span>
            {' · '}<span data-testid="recipient-delivered">{recipient.deliveredRevision === null ? 'nothing delivered' : `delivered revision ${recipient.deliveredRevision}`}</span>
            {' · '}<span data-testid="recipient-acknowledged">{recipient.acknowledgedRevision === null ? 'not acknowledged' : `acknowledged revision ${recipient.acknowledgedRevision}`}</span>
            {recipient.noticeState === 'uncertain' && <> · {onOpenMailbox
              ? <button type="button" className="hover:underline" data-testid="recipient-open-mailbox" onClick={onOpenMailbox}>Resolve in the Mailbox</button>
              : 'resolve it in the Mailbox (Retry or Discard)'}</>}
          </p>)}
        <div className="mt-1 flex gap-2">
          {missing && <button type="button" className="btn text-chat-meta" data-testid="task-notify" disabled={disabled}
            onClick={() => notify(publication.revision, 'notify')}>Notify</button>}
          {failed && <button type="button" className="btn text-chat-meta" data-testid="task-retry-notification" disabled={disabled}
            onClick={() => notify(publication.revision, 'retry')}>Retry notification</button>}
        </div>
      </article>
    })}
    {acknowledgements.length > 0 && <details className="mt-2 text-chat-meta" data-testid="task-acknowledgement-history">
      <summary>Acknowledgement history ({acknowledgements.length})</summary>
      {acknowledgements.map(row => <p key={`${row.sessionId}:${row.revision}`} className="mt-1 border-l-2 border-border pl-2">
        {sessionLabel(row.sessionId, sessions)} acknowledged revision {row.revision} · {new Date(row.createdAt).toLocaleString()}
      </p>)}
    </details>}
  </section>
}
