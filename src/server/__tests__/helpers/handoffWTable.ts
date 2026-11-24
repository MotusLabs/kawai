// Table W (owner-publication-handoff design "Table W"), committed verbatim
// as rows of independent predicates over the raw facts with the item each
// expects (owner kind, needs human, next action). `taskHandoffAttention.test.ts`
// checks the table's completeness against the sources, and P2 uses it as
// its reference model.
import type { HandoffNoticeState } from '../../../shared/taskHandoffs'
import type { AttentionItem } from '../../../shared/teamWorkspace'

export type Shown = { owner: AttentionItem['owner']['kind']; needsHuman: boolean; action: string } | null
export const shown = (items: AttentionItem[]): Shown[] => items.map(item => ({ owner: item.owner.kind, needsHuman: item.requiresHuman, action: item.nextAction }))

// Table W, pending handoffs (verbatim: Id, State, Task owner, Requester → Item, Owner, Needs human, Next action).
export type PendingAxes = { state: 'open' | 'stale'; owner: 'live' | 'none' | 'gone'; requester: 'live' | 'gone' }
export const W_PENDING: Array<{ id: string; match: (t: PendingAxes) => boolean; expect: Shown }> = [
  { id: 'W1', match: t => t.state === 'open' && t.owner === 'live', expect: { owner: 'session', needsHuman: false, action: 'Publish prepared revision' } },
  { id: 'W2', match: t => t.state === 'open' && t.owner !== 'live', expect: { owner: 'human', needsHuman: true, action: 'Publish prepared revision' } },
  { id: 'W3', match: t => t.state === 'stale' && t.requester === 'live', expect: { owner: 'session', needsHuman: false, action: 'Re-prepare or withdraw' } },
  { id: 'W4', match: t => t.state === 'stale' && t.requester === 'gone', expect: { owner: 'group', needsHuman: false, action: 'Re-prepare or withdraw' } },
]

// Table W, published handoffs by `handoffPhase` (verbatim rows, each an independent predicate over the raw facts).
export type PublishedAxes = { closed: boolean; claimant: 'none' | 'live' | 'gone'; acked: boolean; delivered: boolean; notices: HandoffNoticeState[]; owns: boolean }
const open = (t: PublishedAxes) => !t.closed && !(t.claimant !== 'none' && t.acked)
const held = (t: PublishedAxes) => open(t) && t.claimant === 'live'
const undelivered = (t: PublishedAxes) => held(t) && !t.delivered
export const W_PUBLISHED: Array<{ id: string; match: (t: PublishedAxes) => boolean; expect: Shown }> = [
  { id: 'W5', match: t => t.closed, expect: null },
  { id: 'W6', match: t => !t.closed && t.claimant !== 'none' && t.acked, expect: null },
  { id: 'W7', match: t => open(t) && t.claimant !== 'live' && t.owns, expect: { owner: 'kawai', needsHuman: false, action: 'Wait for Kawai' } },
  { id: 'W8', match: t => open(t) && t.claimant !== 'live' && !t.owns, expect: { owner: 'human', needsHuman: true, action: 'Hand off the task' } },
  { id: 'W12d', match: t => held(t) && t.delivered, expect: { owner: 'session', needsHuman: false, action: 'Wait for acknowledgement' } },
  { id: 'W9', match: t => undelivered(t) && t.notices.includes('uncertain'), expect: { owner: 'human', needsHuman: true, action: 'Resolve in the Mailbox (Retry or Discard)' } },
  { id: 'W12', match: t => undelivered(t) && !t.notices.includes('uncertain') && t.notices.includes('queued'), expect: { owner: 'session', needsHuman: false, action: 'Wait for acknowledgement' } },
  { id: 'W10', match: t => undelivered(t) && t.notices.length > 0 && t.notices.every(state => state === 'failed'), expect: { owner: 'human', needsHuman: true, action: 'Retry notification' } },
  { id: 'W11', match: t => undelivered(t) && t.notices.length === 0, expect: { owner: 'human', needsHuman: true, action: 'Notify' } },
]
