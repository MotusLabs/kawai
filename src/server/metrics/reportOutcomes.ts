// Outcomes of implemented proposals (team-process-metrics D6), derived at
// read time. For each expected effect on its own attribution side, the
// metrics core runs over equal windows around the linked change (the longest
// window, shortened to the time elapsed since the change) and keeps only work
// by the target's starts: "before" is work by starts that loaded the hash at
// decision before the change, "after" work by starts that loaded the linked
// hash at or after it — so a reverted hash's old work never counts as after.
// A team- or sender-side metric, or one with no such work on either side (a
// reviewers proposal expecting author-side first-pass yield), compares the
// whole team's windows instead, labeled not attributed. Below `MIN_SAMPLE`
// on either side reads undetermined.
import {
  METRIC_DEF_BY_ID, WINDOW_MS, type MetricDef, type MetricStat,
} from '../../shared/processMetrics'
import type { OutcomeState, ProposalEffectOutcome, ProposalLink } from '../../shared/processReports'
import { observations } from './computeMetrics'
import { metricsContext } from './metricsContext'
import { loadMetricsInputs } from './metricsQuery'
import type { AgentStartRow } from './provenanceRecorder'
import type { ReportReadContext } from './reportRead'
import type { StoredProposal } from './reportStore'
import { StartResolver, aggregate, type Observation } from './slices'

const OUTCOME_SPAN_MS = WINDOW_MS['7d']
const ATTRIBUTABLE = new Set<MetricDef['side']>(['author', 'reviewer', 'turn'])

const statOf = ({ value, n, insufficient }: MetricStat): MetricStat => ({ value, n, insufficient })

export function outcomeState(before: MetricStat, after: MetricStat, direction: 'up' | 'down'): OutcomeState {
  if (before.insufficient || after.insufficient || before.value === null || after.value === null) return 'undetermined'
  if (after.value === before.value) return 'unchanged'
  return (after.value > before.value) === (direction === 'up') ? 'as-expected' : 'opposite'
}

export function proposalOutcome(context: ReportReadContext, proposal: StoredProposal, link: ProposalLink): ProposalEffectOutcome[] {
  const changeAt = Date.parse(link.changeAt)
  const span = Math.max(0, Math.min(OUTCOME_SPAN_MS, context.now - changeAt))
  const inputs = loadMetricsInputs(context.db, context.teamId, changeAt - span, changeAt + span)
  const resolver = new StartResolver(inputs.starts)
  const before = observations(metricsContext(inputs, changeAt - span, changeAt, resolver))
  const after = observations(metricsContext(inputs, changeAt, changeAt + span, resolver))
  const hashOf = (start: AgentStartRow): string | null | undefined => {
    if (proposal.targetKind === 'group') {
      return start.groupId === proposal.target && !start.unavailable.includes('group_file') ? start.groupFileHash : undefined
    }
    if (start.unavailable.includes('memory')) return undefined
    return start.memoryHash ? inputs.manifests.get(start.memoryHash)?.[proposal.target] ?? null : null
  }
  const loaded = (o: Observation, hash: string | null, phase: 'before' | 'after') => {
    if (o.attribution?.kind !== 'start') return false
    const start = o.attribution.start
    const inPhase = phase === 'before' ? start.startedAt < link.changeAt : start.startedAt >= link.changeAt
    return inPhase && hashOf(start) === hash
  }
  const decisionHash = proposal.decision?.targetHashAtDecision ?? null
  return proposal.expected.map(({ metric, direction }) => {
    const def = METRIC_DEF_BY_ID.get(metric)!
    const all = { before: before.get(metric) ?? [], after: after.get(metric) ?? [] }
    if (ATTRIBUTABLE.has(def.side)) {
      const mine = {
        before: aggregate(def, all.before.filter(o => loaded(o, decisionHash, 'before'))),
        after: aggregate(def, all.after.filter(o => loaded(o, link.changeHash, 'after'))),
      }
      if (mine.before.n > 0 || mine.after.n > 0) {
        return { metric, direction, before: statOf(mine.before), after: statOf(mine.after), attributed: true, state: outcomeState(mine.before, mine.after, direction) }
      }
    }
    const team = { before: aggregate(def, all.before), after: aggregate(def, all.after) }
    return { metric, direction, before: statOf(team.before), after: statOf(team.after), attributed: false, state: outcomeState(team.before, team.after, direction) }
  })
}
