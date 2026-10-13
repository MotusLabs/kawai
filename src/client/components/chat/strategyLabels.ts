// Labels for the strategy view (product-strategy 5.1–5.3): claim kinds,
// revision statuses, actors, and short hashes, in the style of
// teamTaskLabels.
import type { Session } from '@shared/types'
import type { StrategyActor, StrategyClaimKind, StrategyRevisionStatus } from '@shared/productStrategy'

export const CLAIM_KIND_LABELS: Record<StrategyClaimKind, string> = {
  owner_preference: 'Owner preference',
  explicit_user_statement: 'Explicit user statement',
  agent_interpretation: 'Agent interpretation',
  proposed_choice: 'Proposed choice',
  hypothesis: 'Hypothesis',
  validated_observation: 'Validated observation',
}

export const claimLabel = (kind: StrategyClaimKind): string => CLAIM_KIND_LABELS[kind]

export const REVISION_STATUS_LABELS: Record<StrategyRevisionStatus, string> = {
  in_review: 'In review',
  approved: 'Approved',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
}

export const actorLabel = (actor: StrategyActor, sessions: Session[] | Record<string, Session>): string =>
  actor.kind === 'human' ? 'Human' : sessionLabel(actor.sessionId, sessions)

export function sessionLabel(sessionId: string, sessions: Session[] | Record<string, Session>): string {
  const row = Array.isArray(sessions) ? sessions.find(session => session.id === sessionId) : sessions[sessionId]
  return row?.name ?? sessionId
}

/** First and last 6 hex chars — enough to compare at a glance, short enough to lay out. */
export const shortHash = (hash: string): string => `${hash.slice(0, 8)}…${hash.slice(-6)}`
