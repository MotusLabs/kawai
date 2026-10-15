// A plan revision's execution policy (durable-plans D12): Kawai's mandatory
// check floor shown beside the plan's extra checks — the floor is policy,
// never content, so it reads the same for every plan — plus plan-wide
// acceptance rules, the landing mode, the roles with their profiles in
// preference order, and the plan's review group.
import { PLAN_CHECK_FLOOR, PLAN_FLOOR_LABELS, type PlanCheck, type PlanContent } from '@shared/plans'
import { ListField } from './PlanIntentSection'

export default function PlanPolicySection({ content }: { content: PlanContent }) {
  return <section data-testid="plan-policy" aria-labelledby="plan-policy-heading" className="mt-3">
    <h4 id="plan-policy-heading" className="font-medium">Checks and policy</h4>
    <div className="mt-1 grid gap-2 sm:grid-cols-2">
      <div data-testid="plan-floor">
        <h5 className="text-chat-meta font-medium text-secondary">Mandatory floor (Kawai policy)</h5>
        <ul className="list-disc pl-5 text-chat-body">{PLAN_CHECK_FLOOR.map(check => <li key={check}>{PLAN_FLOOR_LABELS[check]}</li>)}</ul>
      </div>
      <div data-testid="plan-extra-checks">
        <h5 className="text-chat-meta font-medium text-secondary">Extra checks (this plan)</h5>
        <CheckList checks={content.extraChecks} />
      </div>
    </div>
    <ListField label="Acceptance rules" items={content.acceptanceRules} />
    <div className="mt-1" data-testid="plan-landing">
      <h5 className="text-chat-meta font-medium text-secondary">Landing</h5>
      <p className="text-chat-body">{content.landing.mode === 'direct' ? 'Direct — each change lands on its own' : `Integration branch ${content.landing.branch}`}</p>
    </div>
    <div className="mt-1" data-testid="plan-roles">
      <h5 className="text-chat-meta font-medium text-secondary">Roles</h5>
      {content.roles.length === 0 ? <p className="text-chat-body text-secondary">(none)</p>
        : <ul className="list-disc pl-5 text-chat-body">{content.roles.map(role => <li key={role.group}>
          {role.group}: {role.profiles.length > 0 ? role.profiles.join(' → ') : "the group's own routing"}
        </li>)}</ul>}
      <p className="text-chat-meta text-secondary">Review group: {content.reviewGroup ?? '(none)'}</p>
    </div>
  </section>
}

export function CheckList({ checks }: { checks: PlanCheck[] }) {
  if (checks.length === 0) return <p className="text-chat-body text-secondary">(none)</p>
  return <ul className="list-disc pl-5 text-chat-body">{checks.map(check => <li key={check.name}>
    <span className="font-medium">{check.name}</span>{check.description ? ` — ${check.description}` : ''}
    {check.command && <code className="ml-1 text-chat-meta">{check.command}</code>}
  </li>)}</ul>
}
