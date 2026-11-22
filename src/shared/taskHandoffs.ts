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
