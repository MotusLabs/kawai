// The morning summary (team-workspace D8): the last 24 hours in five buckets
// from the workspace snapshot. A finished turn with no submitted result sits
// only in its own bucket; the runtime-only capacity bucket states its bound.
// Items link to where the existing action lives, like the attention queue.
import type { MorningSummary, SummaryBucket, SummaryItem } from '@shared/teamWorkspace'

const BUCKETS: Array<{ key: keyof Omit<MorningSummary, 'since'>; title: string; note?: string }> = [
  { key: 'completedResults', title: 'Completed results', note: 'Submitted results; acceptance is shown on each.' },
  { key: 'capacityWaits', title: 'Capacity waits' },
  { key: 'approvals', title: 'Approvals' },
  { key: 'uncertainDeliveries', title: 'Uncertain deliveries' },
  { key: 'finishedTurnsWithoutResult', title: 'Finished turns without a result', note: 'Not counted as completed.' },
]

const RUNTIME_ONLY_NOTE = 'Runtime only — lists only waits the running server has observed.'

function Bucket({ title, note, bucket, onOpen }: {
  title: string
  note?: string
  bucket: SummaryBucket
  onOpen: (item: SummaryItem) => void
}) {
  return <section className="border border-border p-2" data-testid="summary-bucket" data-bucket={title}>
    <h4 className="text-chat-meta font-medium">{title} ({bucket.items.length})</h4>
    {bucket.runtimeOnly && <p className="text-chat-meta text-secondary" data-testid="summary-runtime-only">{RUNTIME_ONLY_NOTE}</p>}
    {note && <p className="text-chat-meta text-secondary">{note}</p>}
    {bucket.items.length === 0
      ? <p className="text-chat-meta text-secondary">None.</p>
      : <ul className="mt-1 space-y-0.5">
        {bucket.items.map(item => <li key={item.id}>
          <button type="button" className="text-left text-chat-meta hover:underline" data-testid="summary-item"
            onClick={() => onOpen(item)}>{item.label}</button>
        </li>)}
      </ul>}
  </section>
}

export default function TeamMorningSummary({ summary, onOpen }: {
  summary: MorningSummary
  onOpen: (item: SummaryItem) => void
}) {
  return <section aria-label="Morning summary" data-testid="team-morning-summary">
    <h3 className="font-medium">Morning summary · since {new Date(summary.since).toLocaleString()}</h3>
    <div className="mt-1 grid gap-1 md:grid-cols-2 xl:grid-cols-3">
      {BUCKETS.map(({ key, title, note }) => <Bucket key={key} title={title} {...(note ? { note } : {})}
        bucket={summary[key]} onOpen={onOpen} />)}
    </div>
  </section>
}
