// Labels shared by the Metrics tab's report components (team-process-metrics
// D6): short hashes, targets, version changes, actors, outcome states, and
// report ages. Pure.
import type { OutcomeState, ProposalActor, ProposalTargetKind, VersionChange } from '@shared/processReports'

export type NameOf = (sessionId: string) => string

/** First 8 characters of a hash; `none` for an absent file. */
export const shortHash = (hash: string | null): string => (hash === null ? 'none' : hash.slice(0, 8))

export const targetLabel = (kind: ProposalTargetKind, target: string): string =>
  kind === 'group' ? `group ${target}` : `memory file ${target}`

export const timeLabel = (at: string): string => new Date(at).toLocaleString()

export const changeLabel = (change: Pick<VersionChange, 'previousHash' | 'hash' | 'at'>): string =>
  `${shortHash(change.previousHash)} → ${shortHash(change.hash)} at ${timeLabel(change.at)}`

export const actorLabel = (actor: ProposalActor, nameOf: NameOf): string =>
  actor.kind === 'human' ? 'Human' : `Agent ${actor.sessionId ? nameOf(actor.sessionId) : 'unknown'}`

export const OUTCOME_LABELS: Record<OutcomeState, string> = {
  'as-expected': 'Moved as expected', opposite: 'Moved the opposite way', unchanged: 'Unchanged', undetermined: 'Undetermined',
}

export const ageLabel = (hours: number | null): string => (hours === null ? 'none yet' : `${hours} h ago`)
