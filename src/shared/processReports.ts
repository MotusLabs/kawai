// SDK-free process report model (team-process-metrics D6): reports freeze the
// metric set they were written from; proposals name one target (a group's
// file or one shared memory file), an edit, a rationale, and expected
// effects; the human decides each once; implementation is an explicit link to
// one version change of the target; outcomes and unproposed changes are
// derived at read time. Shared by the store, the agent tools, the WS
// snapshot, and the Metrics tab.
import type { MetricId, MetricStat, MetricWindow, ProcessMetrics } from './processMetrics'

export type ProposalKind = 'change' | 'revert'
export type ProposalTargetKind = 'group' | 'memory'
export type ProposalDirection = 'up' | 'down'

export interface ExpectedEffect {
  metric: MetricId
  direction: ProposalDirection
}

/** What a 1d, 3d, and 7d report may propose (D6 window roles). */
export const WINDOW_PROPOSAL_KINDS: Record<MetricWindow, readonly ProposalKind[]> = {
  '1d': [],
  '3d': ['revert'],
  '7d': ['change', 'revert'],
}

export const WINDOW_RULES: Record<MetricWindow, string> = {
  '1d': 'A 1d report carries no proposals.',
  '3d': 'A 3d report carries only revert proposals.',
  '7d': 'A 7d report may carry change and revert proposals.',
}

/** One recorded version change of a target: a start whose hash differs from the previous start's. */
export interface VersionChange {
  targetKind: ProposalTargetKind
  /** The group id, or the memory file name. */
  target: string
  startId: string
  sessionId: string
  at: string
  hash: string | null
  previousHash: string | null
}

export interface ProposalDecision {
  decision: 'accepted' | 'rejected'
  reason: string | null
  targetHashAtDecision: string | null
  decidedAt: string
}

export type LinkAction = 'link' | 'replace' | 'unlink'

export interface ProposalActor {
  kind: 'human' | 'agent'
  sessionId: string | null
}

export interface ProposalLinkEvent {
  action: LinkAction
  changeStartId: string | null
  changeHash: string | null
  changeAt: string | null
  actor: ProposalActor
  at: string
}

/** The current link: the latest link event unless it is an unlink. */
export interface ProposalLink {
  changeStartId: string
  changeHash: string | null
  changeAt: string
  actor: ProposalActor
  at: string
}

export type OutcomeState = 'as-expected' | 'opposite' | 'unchanged' | 'undetermined'

export interface ProposalEffectOutcome {
  metric: MetricId
  direction: ProposalDirection
  before: MetricStat
  after: MetricStat
  /** False when the comparison is of equal team windows around the change. */
  attributed: boolean
  state: OutcomeState
}

export interface ProcessProposal {
  id: string
  reportId: string
  kind: ProposalKind
  targetKind: ProposalTargetKind
  target: string
  edit: string
  rationale: string
  expected: ExpectedEffect[]
  revertToHash: string | null
  decision: ProposalDecision | null
  link: ProposalLink | null
  linkHistory: ProposalLinkEvent[]
  /** Other proposals whose current link names the same version change. */
  sharedWith: string[]
  /** Version changes a link may name now (accepted proposals only). */
  candidates: VersionChange[]
  /** Present once implemented. */
  outcome?: ProposalEffectOutcome[]
}

export interface ProcessReport {
  id: string
  teamId: string
  authorSession: string
  window: MetricWindow
  periodStart: string
  periodEnd: string
  summary: string
  snapshot: ProcessMetrics
  createdAt: string
  proposals: ProcessProposal[]
}

/** The newest report per window and its age at the read. */
export interface ReportFreshness {
  window: MetricWindow
  latestReportId: string | null
  latestAt: string | null
  ageHours: number | null
}
