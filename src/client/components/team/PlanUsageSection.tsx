// The usage section of a plan's detail (plan-supervision D14, D15): the
// recorded per-turn usage of the plan's linked tasks and its fix and
// correction tasks, summed by group and profile and per change — fix and
// correction tasks form their own rows. Tokens and turns only: no currency
// and no budget, ever, and the notes state what is not counted (turns with
// no task, Task subagent and auxiliary calls). Renders only what the detail
// carries; without the usage module it renders nothing.
import type { PlanUsageView, UsageTotals } from '@shared/planUsage'

const cell = (totals: UsageTotals): string =>
  `${totals.turns} turn${totals.turns === 1 ? '' : 's'} · ${totals.steps} steps · in ${fmt(totals.inputTokens)} · out ${fmt(totals.outputTokens)} · cache read ${fmt(totals.cacheReadTokens)} · cache write ${fmt(totals.cacheCreationTokens)}`

const fmt = (tokens: number): string => tokens.toLocaleString('en-US')

export default function PlanUsageSection({ view: usage }: { view: PlanUsageView }) {
  return <section className="mt-3" data-testid="plan-usage-section" aria-labelledby="plan-usage-heading">
    <h3 id="plan-usage-heading" className="text-chat-meta font-medium">Usage</h3>
    <p className="text-chat-meta" data-testid="plan-usage-total">All roles and profiles: {cell(usage.total)}</p>
    <div className="mt-1" data-testid="plan-usage-by-profile">
      <p className="text-chat-meta font-medium text-secondary">By group and profile</p>
      {usage.byGroupProfile.length === 0
        ? <p className="text-chat-meta text-secondary">No recorded turns yet.</p>
        : <table className="text-chat-meta"><tbody>
          {usage.byGroupProfile.map(row => <tr key={`${row.group ?? ''}:${row.profile ?? ''}`}>
            <th scope="row" className="pr-3 text-left font-normal">{row.group ?? '(no group)'} · {row.profile ?? '(no profile)'}</th>
            <td>{cell(row)}</td>
          </tr>)}
        </tbody></table>}
    </div>
    <div className="mt-1" data-testid="plan-usage-by-change">
      <p className="text-chat-meta font-medium text-secondary">By change</p>
      {usage.byChange.length === 0
        ? <p className="text-chat-meta text-secondary">No recorded turns yet.</p>
        : <ul className="text-chat-meta">
          {usage.byChange.map(row => <li key={row.kind === 'fix' ? `fix:${row.taskId}` : `change:${row.change ?? ''}`}>
            {row.kind === 'fix'
              ? <>Forward {row.sourceKind} task {row.taskId.slice(0, 13)}… — {cell(row)}</>
              : <>{row.change ?? '(task without a change)'} — {cell(row)}</>}
          </li>)}
        </ul>}
    </div>
    <ul className="mt-1 list-disc pl-5 text-chat-meta text-secondary" data-testid="plan-usage-notes">
      {usage.notes.map((note, index) => <li key={index}>{note}</li>)}
    </ul>
  </section>
}
