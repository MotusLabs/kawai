// Pure delivery facts (delivery-outcome-metrics D1/D3). All times are epoch
// milliseconds; positions are one-based on the oldest-first first-parent chain.
export type ObjectFormat = 'sha1' | 'sha256'

/** Only these known failures may be mapped to history validation reasons. */
export class DeliveryHistoryError extends Error {
  constructor(readonly reason: 'history-malformed' | 'history-incomplete') {
    super(reason)
    this.name = 'DeliveryHistoryError'
  }
}

export interface HistoryCommit {
  readonly committedAt: number
  readonly parents: readonly string[]
}

/** A complete DAG, keyed by canonical full object id. */
export type CommitGraph = ReadonlyMap<string, HistoryCommit>

export interface Landing {
  readonly position: number
  readonly at: number
  readonly bound: number
}

export interface Integration extends Landing {
  readonly sha: string
}

export interface LandingPositions {
  readonly chain: readonly Integration[]
  readonly commits: ReadonlyMap<string, Landing>
}

export interface CommitEvidence {
  readonly id: string
  readonly seq: number
  readonly finishedAt: string
}

export type ResultCommit =
  | { kind: 'landed'; sha: string; landing: Landing }
  | { kind: 'not-landed'; sha: string; evidence: CommitEvidence }
  | { kind: 'unresolvable'; reason: 'not-full-literal' | 'no-corroboration' | 'contradictory-check' }
