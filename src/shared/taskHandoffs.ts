// Owner-publication handoffs (owner-publication-handoff design D1, D3, D5):
// an agent's prepared task revision, waiting for the party who may publish
// it. SDK-independent: states, the reserved key namespace, and the canonical
// payload input the server hashes (the hash itself is computed server-side).
import { canonicalJson } from './productStrategy'

export const HANDOFF_STATES = ['open', 'stale', 'published', 'declined', 'withdrawn', 'superseded', 'closed'] as const
export type HandoffState = typeof HANDOFF_STATES[number]

/** Only these are pending; every other state is terminal and immutable (D5). */
export const PENDING_HANDOFF_STATES: readonly HandoffState[] = ['open', 'stale']
export const isPendingHandoff = (state: HandoffState): boolean => PENDING_HANDOFF_STATES.includes(state)

/** The four transitions that wake the next actor (D6); superseded and withdrawn wake nobody. */
export const HANDOFF_WAKEUP_TRANSITIONS = ['published', 'declined', 'stale', 'closed'] as const
export type HandoffWakeupTransition = typeof HANDOFF_WAKEUP_TRANSITIONS[number]

/**
 * The prepared entry's key namespace (D3). Every key the prepared entry
 * writes starts with it; the ordinary entry refuses any canonical key that
 * does, so neither command can replay the other's revision.
 */
export const HANDOFF_KEY_PREFIX = 'handoff:'
export const preparedKey = (handoffId: string): string => `${HANDOFF_KEY_PREFIX}${handoffId}`

/**
 * The ordinary entry's canonical key (D3): trimmed once, exactly as
 * `TaskService.publish` always did, with no other normalization; blank means
 * no key. The same value is the only one classified, looked up and stored.
 */
export function canonicalRequestKey(raw: string | null | undefined): string | undefined {
  return raw?.trim() || undefined
}

export const isReservedRequestKey = (canonical: string | undefined): boolean =>
  canonical !== undefined && canonical.startsWith(HANDOFF_KEY_PREFIX)

/** The prepared fields and notify choice a payload hash covers (D10). */
export interface HandoffPreparedFields {
  direction: string | null
  acceptance: string | null
  contract: string | null
  rationale: string
  notify: boolean
}

/** The canonical JSON the server hashes into `payload_hash` (sha256, shown as its first 12 hex digits). */
export function handoffPayloadInput(fields: HandoffPreparedFields): string {
  return canonicalJson({
    direction: fields.direction, acceptance: fields.acceptance, contract: fields.contract,
    rationale: fields.rationale, notify: fields.notify,
  })
}

export interface HandoffActor {
  kind: 'human' | 'agent' | 'system'
  sessionId: string | null
}

export interface TaskHandoff extends HandoffPreparedFields {
  id: string
  teamId: string
  taskId: string
  baseRevision: number
  /** The base revision's contract hash; null when it carried no contract. */
  baseContractHash: string | null
  payloadHash: string
  baseCommit: string | null
  evidenceRefs: string[]
  requesterSession: string
  requesterGroup: string | null
  requestKey: string
  state: HandoffState
  stateReason: string | null
  stateActor: HandoffActor | null
  publishedRevision: number | null
  publishedPayloadHash: string | null
  supersededBy: string | null
  createdAt: string
  updatedAt: string
}

/**
 * D5's follow-up phases of a `published` handoff, in `handoffPhase`'s check
 * order (first match wins). Suppression (task-closed, acknowledged) outranks
 * notice parity; phases 4–8 mirror `TaskNotices.reached`.
 */
export const HANDOFF_PHASES = [
  'task-closed', 'acknowledged', 'no-holder', 'delivered-awaiting-ack', 'notice-uncertain', 'notice-queued', 'notice-failed', 'not-notified',
] as const
export type HandoffPhase = typeof HANDOFF_PHASES[number]

/** A revision notice's derived state, as `taskNotices.ts` derives it (a missing notice is not listed). */
export type HandoffNoticeState = 'queued' | 'delivered' | 'uncertain' | 'failed'

/** The facts a published handoff's phase reads, all shown by the publication detail already (D5). */
export interface HandoffFollowUpFacts {
  publishedRevision: number
  taskClosed: boolean
  /** The outstanding assignment's current claimant; null when nobody holds it. */
  claimant: { sessionId: string; live: boolean } | null
  /** The highest revision task mail confirmed delivered to the claimant carried. */
  deliveredRevision: number | null
  acknowledgedRevision: number | null
  /** Every notice to the claimant for the published revision or a later one (never only the newest). */
  notices: Array<{ state: HandoffNoticeState; messageId: string }>
}

/** D5: the one derivation attention, the supervision loader and `task_get` call (contract I5). */
export function handoffPhase(facts: HandoffFollowUpFacts): HandoffPhase {
  if (facts.taskClosed) return 'task-closed'
  if (facts.claimant !== null && (facts.acknowledgedRevision ?? 0) >= facts.publishedRevision) return 'acknowledged'
  if (facts.claimant === null || !facts.claimant.live) return 'no-holder'
  if ((facts.deliveredRevision ?? 0) >= facts.publishedRevision) return 'delivered-awaiting-ack'
  if (facts.notices.some(notice => notice.state === 'uncertain')) return 'notice-uncertain'
  if (facts.notices.some(notice => notice.state === 'queued')) return 'notice-queued'
  // A delivered notice implies a delivered revision at or above it, read above.
  if (facts.notices.length > 0) return 'notice-failed'
  return 'not-notified'
}

/** Who moves a pending handoff next (W1–W4): its publisher while `open`, the requester side once `stale`. */
export type HandoffNextActor =
  | { kind: 'owner'; sessionId: string }
  | { kind: 'human' }
  | { kind: 'requester'; sessionId: string }
  | { kind: 'requester-group'; group: string }

/**
 * W1–W4's next actor, shared by attention and the supervision wait (P6).
 * A stale handoff whose requester is gone and had no group falls to the
 * human, the only party left who can end it (by declining it).
 */
export function pendingHandoffActor(
  handoff: Pick<TaskHandoff, 'state' | 'requesterSession' | 'requesterGroup'>,
  liveOwner: string | null,
  requesterLive: boolean,
): HandoffNextActor {
  if (handoff.state === 'open') return liveOwner !== null ? { kind: 'owner', sessionId: liveOwner } : { kind: 'human' }
  if (requesterLive) return { kind: 'requester', sessionId: handoff.requesterSession }
  return handoff.requesterGroup !== null ? { kind: 'requester-group', group: handoff.requesterGroup } : { kind: 'human' }
}
