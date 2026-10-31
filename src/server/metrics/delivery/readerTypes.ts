// Dormant delivery source contracts (D1/D2). No runner, lifecycle or cache
// publication is activated here. All exposed timestamps are epoch milliseconds.
import type { ObjectFormat } from './types'

export const DELIVERY_READER_VERSION = 1
export const DELIVERY_READ_BOUND = 64 * 1024 * 1024
export const DELIVERY_METADATA_BOUND = 64 * 1024 * 1024
export const DELIVERY_REF_BOUND = 4 * 1024
export const FETCH_PROVENANCE = 'common-directory/main-worktree FETCH_HEAD mtime' as const

export interface RepositoryLocation {
  readonly commonDir: string
  readonly mainCheckout: string
}

export interface PhysicalIdentity {
  readonly dev: string
  readonly ino: string
}

export interface ResolvedTarget {
  readonly repository: string
  readonly main: string
  readonly rootIdentity: PhysicalIdentity
  readonly mainIdentity: PhysicalIdentity
  readonly H: string
  readonly objectFormat: ObjectFormat
  readonly readerVersion: typeof DELIVERY_READER_VERSION
}

export type SourceReason = 'no-default-branch' | 'default-branch-unreadable'
  | 'history-incomplete:shallow' | 'history-incomplete:grafts' | 'history-incomplete:partial'
export type FetchReason = 'missing' | 'unsafe' | 'unreadable' | 'unavailable'
  | 'invalid-time' | 'invalid-now' | 'future-time' | null

export interface FetchEvidence {
  readonly fetchAt: number | null
  readonly fetchReason: FetchReason
}

export interface SourceState extends FetchEvidence {
  readonly target: ResolvedTarget | null
  readonly reason: SourceReason | null
  readonly detail: string | null
  readonly fetchProvenance: typeof FETCH_PROVENANCE
}
