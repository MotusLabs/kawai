// One shared resolution memo for the profile catalog (catalog-resolution-cache
// D1–D2). Resolution reads only the catalog files that exist among the
// context's levels, plus HOME and CODEX_HOME, so the memo is keyed by exactly
// that: every project path that sees the same files shares one entry, and an
// edit, a new file, or a deleted one changes the key — seen at the next
// lookup, as the per-path stamp keys were. Eviction is least-recently-used at
// a fixed bound, never a full clear, so a hot set of contexts never thrashes.
// Entries hand out the catalog they hold: consumers read it, never mutate it.
import fs from 'node:fs'
import os from 'node:os'
import type { MergedProvider } from './catalogMerge'
import {
  DEFAULT_PROFILE_CATALOG_PATH,
  DEFAULT_PROVIDER_CATALOG_PATH,
  profileCatalogLevels,
  resolveProfileCatalog,
  type ProfileCatalog,
  type ProfileCatalogContext,
} from './profileCatalog'

export const CATALOG_MEMO_LIMIT = 64

/**
 * The inputs resolution reads: HOME, CODEX_HOME, the shipped default paths,
 * and each existing level file with its kind, trust, tier, and stamp. A
 * missing file drops out — its effect is carried by the tiers of the files
 * that do exist.
 */
export function catalogInputKey(ctx: ProfileCatalogContext = {}): string {
  const parts = [
    ctx.homeDir ?? process.env.HOME ?? os.homedir(),
    ctx.serverCodexHome ?? process.env.CODEX_HOME ?? '',
    ctx.imageDefaultProvidersPath ?? DEFAULT_PROVIDER_CATALOG_PATH,
    ctx.imageDefaultPath ?? DEFAULT_PROFILE_CATALOG_PATH,
  ]
  for (const level of profileCatalogLevels(ctx)) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(level.file)
    } catch {
      continue
    }
    parts.push([level.file, level.kind, level.trusted, level.tier, stat.mtimeMs, stat.size].join('\0'))
  }
  return parts.join('\n')
}

/** One memoized resolution and the projections consumers read from it. */
export class CatalogEntry {
  private providerIds?: ReadonlyMap<string, string>
  private labels?: ReadonlyMap<string, string>

  constructor(readonly catalog: ProfileCatalog) {}

  /** Profile id → its provider id. */
  providerByProfile(): ReadonlyMap<string, string> {
    this.providerIds ??= new Map([...this.catalog.profiles].map(([id, profile]) => [id, profile.providerId]))
    return this.providerIds
  }

  /** Provider id → its catalog label. */
  providerLabels(): ReadonlyMap<string, string> {
    this.labels ??= new Map([...this.catalog.providers].map(([id, provider]) => [id, provider.label]))
    return this.labels
  }

  /** Provider id → its merged definition. */
  definitions(): ReadonlyMap<string, MergedProvider> {
    return this.catalog.merged
  }
}

/** An LRU memo of resolutions by input key; `resolve` is the seam tests count. */
export class CatalogMemo {
  private readonly entries = new Map<string, CatalogEntry>()

  constructor(
    private readonly resolve: (ctx: ProfileCatalogContext) => ProfileCatalog = ctx => resolveProfileCatalog(ctx),
    private readonly limit = CATALOG_MEMO_LIMIT,
  ) {}

  get(ctx: ProfileCatalogContext = {}): CatalogEntry {
    const key = catalogInputKey(ctx)
    const hit = this.entries.get(key)
    if (hit) {
      // Map order is insertion order: re-inserting marks the entry newest.
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    const entry = new CatalogEntry(this.resolve(ctx))
    this.entries.set(key, entry)
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string)
    return entry
  }

  get size(): number {
    return this.entries.size
  }
}

const shared = new CatalogMemo()

/** The memoized catalog entry for a context, shared by every consumer. */
export function resolvedCatalog(ctx: ProfileCatalogContext = {}): CatalogEntry {
  return shared.get(ctx)
}

/**
 * The provider owning `profileId` (D10), from the shared memo. A profile that
 * is no longer in the catalog stands in as its own provider, so a session
 * launched before a catalog edit keeps a stable cooldown and usage key.
 */
export function providerOf(profileId: string, ctx: ProfileCatalogContext = {}): string {
  return resolvedCatalog(ctx).providerByProfile().get(profileId) ?? profileId
}

/**
 * The provider's catalog label (providers-and-workers D14), from the shared
 * memo. A provider the catalog no longer names has no label.
 */
export function providerLabelOf(providerId: string, ctx: ProfileCatalogContext = {}): string | null {
  return resolvedCatalog(ctx).providerLabels().get(providerId) ?? null
}
