// Dormant exported filesystem composition. Supplied common/main locations are
// canonicalized per call; no process, owner gate, retry, clock fallback or repair.
import { MetadataError, MetadataRoot } from './metadataFiles'
import { isFullLiteral } from './objectFormat'
import { PackedRefIndex, validRefName } from './packedRefs'
import { parseRepositoryConfig } from './repositoryConfig'
import { DELIVERY_METADATA_BOUND, DELIVERY_READER_VERSION, DELIVERY_REF_BOUND, FETCH_PROVENANCE } from './readerTypes'
import type { FetchEvidence, RepositoryLocation, SourceReason, SourceState } from './readerTypes'
import type { ObjectFormat } from './types'

export function normalizeFetchEvidence(mtimeMs: unknown, now: unknown): FetchEvidence {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) return { fetchAt: null, fetchReason: 'invalid-now' }
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return { fetchAt: null, fetchReason: 'invalid-time' }
  const fetchAt = Math.floor(mtimeMs)
  return fetchAt > Math.floor(now) ? { fetchAt: null, fetchReason: 'future-time' } : { fetchAt, fetchReason: null }
}

function fetchEvidence(root: MetadataRoot, now: number): FetchEvidence {
  if (!Number.isFinite(now) || now < 0) return { fetchAt: null, fetchReason: 'invalid-now' }
  try { return root.withFile('FETCH_HEAD', undefined, file => normalizeFetchEvidence(file.mtimeMs(), now)) }
  catch (error) {
    const kind = error instanceof MetadataError ? error.kind : 'unreadable'
    return { fetchAt: null, fetchReason: kind === 'missing' ? 'missing' : kind === 'unsafe' ? 'unsafe' : 'unreadable' }
  }
}

function unavailable(reason: SourceReason, evidence: FetchEvidence = { fetchAt: null, fetchReason: 'unavailable' }): SourceState {
  return Object.freeze({ target: null, reason, ...evidence, fetchProvenance: FETCH_PROVENANCE,
    detail: reason === 'no-default-branch' ? 'Set the local default branch with git remote set-head origin --auto.' : null })
}

export class DeliverySourceResolver {
  constructor(private readonly packed = new PackedRefIndex()) {}

  private head(root: MetadataRoot, format: ObjectFormat): { H: string } | { reason: SourceReason } {
    let name = 'refs/remotes/origin/HEAD', hops = 0
    const seen = new Set<string>()
    for (;;) {
      if (!validRefName(name) || seen.has(name)) return { reason: 'default-branch-unreadable' }
      seen.add(name)
      let text: string | undefined
      try { text = root.text(name, DELIVERY_REF_BOUND) }
      catch (error) { if (!(error instanceof MetadataError) || error.kind !== 'missing') throw error }
      if (text === undefined) text = this.packed.lookup(root, name, format)
      if (text === undefined) return { reason: hops === 0 ? 'no-default-branch' : 'default-branch-unreadable' }
      const line = text.replace(/\r?\n$/, '')
      const candidate: unknown = line // keeps `line` a string past the guard
      if (isFullLiteral(candidate, format)) return { H: candidate }
      if (!line.startsWith('ref: ') || !validRefName(line.slice(5)) || hops >= 5) return { reason: 'default-branch-unreadable' }
      name = line.slice(5)
      hops++
    }
  }

  resolveHead(location: RepositoryLocation, now: number): SourceState {
    let common: MetadataRoot | undefined, main: MetadataRoot | undefined
    let result: SourceState
    try {
      common = new MetadataRoot(location.commonDir)
      main = new MetadataRoot(location.mainCheckout)
      const evidence = fetchEvidence(common, now)
      const config = parseRepositoryConfig(common.text('config', DELIVERY_METADATA_BOUND))
      if (!config.ok) result = unavailable(config.reason, evidence)
      else if (common.hasFile('shallow')) result = unavailable('history-incomplete:shallow', evidence)
      else if (common.hasFile('info/grafts')) result = unavailable('history-incomplete:grafts', evidence)
      else if (common.hasPromisorPack()) result = unavailable('history-incomplete:partial', evidence)
      else {
        const head = this.head(common, config.objectFormat)
        result = 'H' in head
          ? Object.freeze({ target: Object.freeze({ repository: common.repository, main: main.repository,
            rootIdentity: common.identity, mainIdentity: main.identity, H: head.H, objectFormat: config.objectFormat,
            readerVersion: DELIVERY_READER_VERSION }), reason: null, detail: null, ...evidence, fetchProvenance: FETCH_PROVENANCE })
          : unavailable(head.reason, evidence)
      }
      common.assertCurrent(); main.assertCurrent()
      if (result.target === null) this.packed.invalidate()
    } catch (error) {
      this.packed.invalidate()
      const missingRoot = common === undefined && error instanceof MetadataError && error.kind === 'missing'
      result = unavailable(missingRoot ? 'no-default-branch' : 'default-branch-unreadable')
    } finally {
      // close() drops its descriptor before closing, so no stale numeric retry.
      for (const root of [main, common]) {
        try { root?.close() }
        catch { this.packed.invalidate(); result = unavailable('default-branch-unreadable') }
      }
    }
    return result
  }
}
