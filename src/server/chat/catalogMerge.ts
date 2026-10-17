// Tier merge for the layered catalog (design D2/D3): provider files first,
// farthest level first, then the legacy `profiles.json` entries of each
// level. Same-id providers merge with the nearer scalar winning and env
// merging per key. A model key defined under two providers of different
// operator levels is an error naming both, the nearer definition ignored;
// a nearer definition of a SHIPPED model key re-homes instead, starting
// from the shipped model's flattened settings, so an existing project
// override keeps its launch settings. Legacy entries read as one-model
// providers (D3) unless their id names an existing provider.
import type { ParsedProvider, PartialProfile } from './profileCatalog'

/** The settings a re-homed model carries from the shipped provider it left. */
export interface InheritedSettings {
  env: Record<string, string>
  label?: string
  model?: string
  executable?: string
  limitResetTimeZone?: string
}

export interface MergedModel {
  label?: string
  model?: string
  env: Record<string, string>
  inherited?: InheritedSettings
}

export interface MergedProvider {
  label?: string
  env: Record<string, string>
  executable?: string
  limitResetTimeZone?: string
  models: Map<string, MergedModel>
  /** An operator file introduced this provider; overlays never change it (F2). */
  operatorOrigin: boolean
  /**
   * A shipped provider's operator-overlay facts (F2): its own facts and its
   * shipped keys stay untouched; these reach only the keys the overlay file
   * itself defines.
   */
  operatorOverlay?: { label?: string; env: Record<string, string>; executable?: string; limitResetTimeZone?: string }
  /** The first file that defined it, for duplicate-key errors. */
  originFile: string
}

/** The flattened settings of one model under its provider, env included. */
export function flattenModel(provider: MergedProvider, model: MergedModel): {
  label?: string
  model?: string
  env: Record<string, string>
  executable?: string
  limitResetTimeZone?: string
} {
  return {
    label: model.label ?? model.inherited?.label ?? provider.label,
    model: model.model ?? model.inherited?.model,
    env: { ...model.inherited?.env, ...provider.env, ...model.env },
    executable: provider.executable ?? model.inherited?.executable,
    limitResetTimeZone: provider.limitResetTimeZone ?? model.inherited?.limitResetTimeZone,
  }
}

/** Where a model key sits, and whether an operator file has defined it (B2). */
interface KeyHolder {
  provider: string
  /** An operator file defined or overlaid this key; provider facts never do. */
  operator: boolean
  /** The operator file that defined the key, for duplicate errors. */
  originFile: string
  /** The provider is the key's own one-model provider (legacy chain, re-home, reserved). */
  own: boolean
}

/** Provider ids taken by legacy entries naming a shipped-only provider (B1). */
export function reservedProviderId(id: string): string {
  return `profile:${id}`
}

export class CatalogMerger {
  /** Providers in first-seen (farthest file first) order. */
  readonly providers = new Map<string, MergedProvider>()
  readonly errors: string[] = []
  /** Model key → where it sits and which tier defined it. */
  private holders = new Map<string, KeyHolder>()

  private setHolder(key: string, holder: KeyHolder): void {
    this.holders.set(key, holder)
  }

  /** Merge one parsed `providers.json` (design D2). */
  addProviders(file: string, shipped: boolean, providers: Map<string, ParsedProvider>): void {
    for (const [id, provider] of providers) {
      let merged = this.providers.get(id)
      if (!merged) {
        merged = {
          label: provider.label,
          env: { ...provider.env },
          executable: provider.executable,
          limitResetTimeZone: provider.limitResetTimeZone,
          models: new Map(),
          operatorOrigin: !shipped,
          originFile: file,
        }
        this.providers.set(id, merged)
      } else if (merged.operatorOrigin) {
        // An operator provider layers the overlay on, nearest wins (D2).
        merged.label = provider.label ?? merged.label
        merged.env = { ...merged.env, ...provider.env }
        merged.executable = provider.executable ?? merged.executable
        merged.limitResetTimeZone = provider.limitResetTimeZone ?? merged.limitResetTimeZone
      } else {
        // A shipped provider keeps its own facts under an operator overlay
        // (F2): the overlay's facts reach only the keys this file defines.
        merged.operatorOverlay = {
          label: provider.label,
          env: { ...provider.env },
          executable: provider.executable,
          limitResetTimeZone: provider.limitResetTimeZone,
        }
      }
      for (const [key, model] of provider.models) {
        const existing = merged.models.get(key)
        if (existing) {
          existing.label = model.label ?? existing.label
          existing.model = model.model ?? existing.model
          existing.env = { ...existing.env, ...model.env }
          if (!shipped) {
            const holder = this.holders.get(key)!
            holder.operator = true
            holder.originFile = file
          }
          continue
        }
        const holder = this.holders.get(key)
        if (holder !== undefined && holder.provider !== id) {
          if (holder.operator) {
            this.errors.push(`${file}: model "${key}" is already defined under provider "${holder.provider}" (${holder.originFile}); the nearer definition is ignored.`)
            continue
          }
          // Re-home: the still-shipped key leaves its provider (D2),
          // carrying its flattened settings below this provider's overlay.
          const holderProvider = this.providers.get(holder.provider)!
          const flat = flattenModel(holderProvider, holderProvider.models.get(key)!)
          holderProvider.models.delete(key)
          this.setHolder(key, { provider: id, operator: !shipped, originFile: file, own: false })
          merged.models.set(key, {
            label: model.label ?? flat.label,
            model: model.model ?? flat.model,
            env: model.env,
            inherited: {
              env: flat.env,
              label: flat.label,
              model: flat.model,
              executable: flat.executable,
              limitResetTimeZone: flat.limitResetTimeZone,
            },
          })
          continue
        }
        this.setHolder(key, { provider: id, operator: !shipped, originFile: file, own: false })
        const overlay = !shipped ? undefined : merged.operatorOverlay
        merged.models.set(key, {
          label: model.label ?? overlay?.label,
          model: model.model,
          env: { ...model.env },
          ...(overlay ? {
            inherited: {
              env: overlay.env,
              label: overlay.label,
              executable: overlay.executable,
              limitResetTimeZone: overlay.limitResetTimeZone,
            },
          } : {}),
        })
      }
    }
  }

  /**
   * Merge one parsed `profiles.json`: entries read as one-model providers
   * (D3). Resolution order (lead ruling B1): the id is a model key first —
   * overlay its own one-model provider, re-home a still-shipped key, ignore
   * an operator key under another provider with an error; then an operator
   * provider's id merges into it; otherwise the entry becomes a new
   * one-model provider — one naming a shipped-only provider takes the
   * reserved `profile:<id>` id and leaves the shipped provider unchanged.
   */
  addProfiles(file: string, shipped: boolean, entries: Map<string, PartialProfile>): void {
    for (const [id, entry] of entries) {
      const holder = this.holders.get(id)
      if (holder !== undefined) {
        const holderProvider = this.providers.get(holder.provider)!
        if (holder.own) {
          this.mergeIntoProvider(holderProvider, id, entry, shipped, file)
          continue
        }
        if (holder.operator) {
          this.errors.push(`${file}: profile "${id}" is a model of provider "${holder.provider}" (${holder.originFile}); the entry is ignored.`)
          continue
        }
        // Re-home into a one-model provider over the shipped settings.
        const flat = flattenModel(holderProvider, holderProvider.models.get(id)!)
        holderProvider.models.delete(id)
        this.providers.set(id, {
          label: entry.label ?? flat.label,
          env: {},
          executable: entry.executable ?? flat.executable,
          limitResetTimeZone: entry.limitResetTimeZone ?? flat.limitResetTimeZone,
          models: new Map([[id, {
            label: entry.label ?? flat.label,
            model: entry.model ?? flat.model,
            env: { ...entry.env },
            inherited: { env: flat.env, label: flat.label, model: flat.model },
          }]]),
          operatorOrigin: !shipped,
          originFile: file,
        })
        this.setHolder(id, { provider: id, operator: !shipped, originFile: file, own: true })
        continue
      }
      const provider = this.providers.get(id)
      if (provider && provider.operatorOrigin) {
        this.mergeIntoProvider(provider, id, entry, shipped, file)
        continue
      }
      if (provider) {
        // The id names a shipped-only provider: a reserved one-model
        // provider holds the entry, and the shipped provider is unchanged.
        const reservedId = reservedProviderId(id)
        this.providers.set(reservedId, {
          label: entry.label,
          env: {},
          executable: entry.executable,
          limitResetTimeZone: entry.limitResetTimeZone,
          models: new Map([[id, { label: entry.label, model: entry.model, env: { ...entry.env } }]]),
          operatorOrigin: !shipped,
          originFile: file,
        })
        this.setHolder(id, { provider: reservedId, operator: !shipped, originFile: file, own: true })
        continue
      }
      // A brand-new one-model provider: the entry's env sits on the model,
      // so a later same-key entry merges per key exactly as it did when the
      // catalog was flat.
      this.providers.set(id, {
        label: entry.label,
        env: {},
        executable: entry.executable,
        limitResetTimeZone: entry.limitResetTimeZone,
        models: new Map([[id, { label: entry.label, model: entry.model, env: { ...entry.env } }]]),
        operatorOrigin: !shipped,
        originFile: file,
      })
      this.setHolder(id, { provider: id, operator: !shipped, originFile: file, own: true })
    }
  }

  /** A legacy entry whose id names an existing operator provider merges into it. */
  private mergeIntoProvider(provider: MergedProvider, id: string, entry: PartialProfile, shipped: boolean, file: string): void {
    if (!shipped) {
      const holder = this.holders.get(id)
      if (holder) {
        holder.operator = true
        holder.originFile = file
      }
    }
    const model = provider.models.get(id)
    if (model) {
      // The provider holds a model of the entry's key (the one-model legacy
      // chain): the entry overlays that model, nearest value per key.
      model.label = entry.label ?? model.label
      model.model = entry.model ?? model.model
      model.env = { ...model.env, ...entry.env }
      // Keep a one-model provider's label equal to its model's, so the
      // picker renders the pair as the plain option it has always been.
      if (provider.models.size === 1) provider.label = entry.label ?? provider.label
    } else {
      // Provider-level facts; a startup model with no matching model key has
      // no place to land and is reported, never dropped silently (F2).
      provider.label = entry.label ?? provider.label
      provider.env = { ...provider.env, ...entry.env }
      if (entry.model !== undefined) {
        this.errors.push(`${file}: model "${entry.model}" is ignored: provider "${id}" holds other models and takes no startup model.`)
      }
    }
    provider.executable = entry.executable ?? provider.executable
    provider.limitResetTimeZone = entry.limitResetTimeZone ?? provider.limitResetTimeZone
  }

  /** The implicit `default` (D4): joined to a `default` provider, else synthesized. */
  finish(): void {
    if (this.holders.has('default')) return
    const provider = this.providers.get('default')
    if (provider) {
      provider.models.set('default', { label: 'Default', env: {} })
      this.setHolder('default', { provider: 'default', operator: false, originFile: '(implicit)', own: true })
      return
    }
    this.providers.set('default', {
      label: 'Default',
      env: {},
      models: new Map([['default', { label: 'Default', env: {} }]]),
      operatorOrigin: false,
      originFile: '(implicit)',
    })
    this.setHolder('default', { provider: 'default', operator: false, originFile: '(implicit)', own: true })
  }
}
