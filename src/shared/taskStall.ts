// Stall state of a manually managed task (manual-task-stall-alerts D1): the
// one derivation the notice module and every oracle table share. A task's
// anchor is its latest progress (creation, revision, result, counted review,
// or stall notice); the count is the agent and human mail after it. A notice
// is due only when both thresholds hold on an open or active task that no
// execution owns. Pure: no clock, no store.
import type { TaskStatus } from './teamTasks'

export const STALL_MESSAGE_THRESHOLD = 10
export const STALL_ELAPSED_MS = 3 * 60 * 60 * 1000

/** Anchor kinds in tie order: on equal times the earlier kind names the anchor. */
export const STALL_ANCHOR_KINDS = ['created', 'revision', 'result', 'review', 'notice'] as const
export type StallAnchorKind = typeof STALL_ANCHOR_KINDS[number]

export interface StallMail {
  createdAt: string
  fromKind: 'agent' | 'human' | 'system'
  fromSession: string | null
  fromGroup: string | null
}

export interface StallInput {
  status: TaskStatus
  owned: boolean
  createdAt: string
  revisionAt: string | null
  resultAt: string | null
  reviewAt: string | null
  noticeAt: string | null
  mail: readonly StallMail[]
  now: string
}

export interface StallState {
  anchorAt: string
  anchorKind: StallAnchorKind
  count: number
  senders: string[]
  elapsedMs: number
  due: boolean
}

/** Whether a message counts toward a stall: Kawai's own mail never does. */
export function countsTowardStall(mail: Pick<StallMail, 'fromKind'>): boolean {
  return mail.fromKind === 'agent' || mail.fromKind === 'human'
}

function senderOf(mail: StallMail): string {
  if (mail.fromKind === 'human') return 'human'
  return mail.fromSession ?? mail.fromGroup ?? 'agent'
}

export function stallAnchor(input: Pick<StallInput, 'createdAt' | 'revisionAt' | 'resultAt' | 'reviewAt' | 'noticeAt'>): { anchorAt: string; anchorKind: StallAnchorKind } {
  const times: Record<StallAnchorKind, string | null> = {
    created: input.createdAt, revision: input.revisionAt, result: input.resultAt, review: input.reviewAt, notice: input.noticeAt,
  }
  let anchorKind: StallAnchorKind = 'created'
  let anchorAt = input.createdAt
  for (const kind of STALL_ANCHOR_KINDS) {
    const at = times[kind]
    if (at !== null && Date.parse(at) > Date.parse(anchorAt)) { anchorAt = at; anchorKind = kind }
  }
  return { anchorAt, anchorKind }
}

export function stallOf(input: StallInput): StallState {
  const { anchorAt, anchorKind } = stallAnchor(input)
  const anchorMs = Date.parse(anchorAt)
  const counted = input.mail.filter(mail => countsTowardStall(mail) && Date.parse(mail.createdAt) > anchorMs)
  const senders = [...new Set(counted.map(senderOf))].sort()
  // A skewed anchor later than now reads as elapsed 0 (AN9), never negative.
  const elapsedMs = Math.max(0, Date.parse(input.now) - anchorMs)
  const eligible = (input.status === 'open' || input.status === 'active') && !input.owned
  const due = eligible && counted.length >= STALL_MESSAGE_THRESHOLD && elapsedMs >= STALL_ELAPSED_MS
  return { anchorAt, anchorKind, count: counted.length, senders, elapsedMs, due }
}
