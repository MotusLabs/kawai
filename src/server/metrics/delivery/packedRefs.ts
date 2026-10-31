// One optional parsed packed index; every lookup validates/hashes fresh bytes.
// This is neither a facts generation nor a liveness/admission mechanism.
import { createHash } from 'node:crypto'
import { isFullLiteral } from './objectFormat'
import { MetadataError, reliableMetadataToken } from './metadataFiles'
import type { MetadataFile, MetadataRoot } from './metadataFiles'
import { DELIVERY_METADATA_BOUND, DELIVERY_REF_BOUND } from './readerTypes'
import type { ObjectFormat } from './types'

export function validRefName(name: string): boolean {
  return name.startsWith('refs/') && Buffer.byteLength(name, 'utf8') <= DELIVERY_REF_BOUND
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(name) && !name.includes('@{') && !name.includes('..')
    && name.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}

export function parsePackedRefs(text: string, format: ObjectFormat): ReadonlyMap<string, string> {
  const refs = new Map<string, string>()
  let canPeel = false
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('^')) {
      if (!canPeel || !isFullLiteral(line.slice(1), format)) throw new MetadataError('unsafe')
      canPeel = false
      continue
    }
    const space = line.indexOf(' ')
    const sha = line.slice(0, space), name = line.slice(space + 1)
    if (space < 0 || !isFullLiteral(sha, format) || !validRefName(name) || refs.has(name)) {
      throw new MetadataError('unsafe')
    }
    refs.set(name, sha)
    canPeel = true
  }
  return refs
}

export class PackedRefIndex {
  private cached: { key: string; digest: string; refs: ReadonlyMap<string, string> } | undefined
  private parsed = 0
  /** Null disables reuse only; MetadataRoot still validates every snapshot. */
  constructor(private readonly cacheToken: (stat: MetadataFile['stat']) => string | null = reliableMetadataToken) {}
  /** Diagnostic count for the actual metadata-cache oracles, not a metric. */
  get parseCount(): number { return this.parsed }
  invalidate(): void { this.cached = undefined }

  lookup(root: MetadataRoot, name: string, format: ObjectFormat): string | undefined {
    if (!validRefName(name)) throw new MetadataError('unsafe')
    try {
      return root.withFile('packed-refs', DELIVERY_METADATA_BOUND, file => {
        // Hash and decode the same complete per-open snapshot, including on hits.
        const digest = createHash('sha256').update(file.readBytes()).digest('hex')
        const text = file.readText()
        const token = this.cacheToken(file.stat)
        const key = `${root.repository}\0${root.identity.dev}:${root.identity.ino}\0${format}\0${token}`
        if (token !== null && this.cached?.key === key && this.cached.digest === digest) return this.cached.refs.get(name)
        this.invalidate()
        const refs = parsePackedRefs(text, format)
        this.parsed++
        if (token !== null) this.cached = { key, digest, refs }
        return refs.get(name)
      })
    } catch (error) {
      this.invalidate()
      if (error instanceof MetadataError && error.kind === 'missing') return undefined
      throw error
    }
  }
}
