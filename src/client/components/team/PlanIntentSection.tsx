// A plan revision's intent (durable-plans D12): goal, success criteria,
// non-goals, approach, and the alignment statement — labeled as claimed by
// the author and not assessed — with the strategy pin it was submitted
// against, or Alignment unassessed when the team had no approved strategy.
import type { PlanContent, PlanStrategyPin } from '@shared/plans'
import { pinLabel } from './planLabels'

export default function PlanIntentSection({ content, pin }: { content: PlanContent; pin: PlanStrategyPin | null }) {
  return <section data-testid="plan-intent" aria-labelledby="plan-intent-heading" className="mt-3">
    <h4 id="plan-intent-heading" className="font-medium">Intent</h4>
    <Field label="Goal" value={content.goal} />
    <ListField label="Success criteria" items={content.successCriteria} />
    <ListField label="Non-goals" items={content.nonGoals} />
    <Field label="Approach" value={content.approach} />
    <div className="mt-2 border border-border p-2" data-testid="plan-alignment">
      <h5 className="text-chat-meta font-medium text-secondary">Alignment <span className="font-normal">(claimed by the author, not assessed)</span></h5>
      <p className="whitespace-pre-wrap text-chat-body">{content.alignment.statement || '(no alignment statement)'}</p>
      {content.alignment.refs.length > 0 && <p className="text-chat-meta text-secondary">Cites {content.alignment.refs.join(', ')}</p>}
      <p className="text-chat-meta text-secondary" data-testid="plan-pin">{pinLabel(pin)}</p>
    </div>
  </section>
}

export function Field({ label, value }: { label: string; value: string }) {
  return <div className="mt-1">
    <h5 className="text-chat-meta font-medium text-secondary">{label}</h5>
    <p className="whitespace-pre-wrap text-chat-body">{value || '(empty)'}</p>
  </div>
}

export function ListField({ label, items }: { label: string; items: string[] }) {
  return <div className="mt-1">
    <h5 className="text-chat-meta font-medium text-secondary">{label}</h5>
    {items.length === 0 ? <p className="text-chat-body text-secondary">(none)</p>
      : <ul className="list-disc pl-5 text-chat-body">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>}
  </div>
}
