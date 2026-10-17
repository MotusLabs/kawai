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
  /** An operator (non-shipped) file has defined or merged this provider. */
  operator: boolean
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

export class CatalogMerger {
  /** Providers in first-seen (farthest file first) order. */
  readonly providers = new Map<string, MergedProvider>()
  readonly errors: string[] = []
  /** Model key → the provider holding it. */
  private holders = new Map<string, string>()

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
          operator: !shipped,
          originFile: file,
        }
        this.providers.set(id, merged)
      } else {
        if (!shipped) merged.operator = true
        merged.label = provider.label ?? merged.label
        merged.env = { ...merged.env, ...provider.env }
        merged.executable = provider.executable ?? merged.executable
        merged.limitResetTimeZone = provider.limitResetTimeZone ?? merged.limitResetTimeZone
      }
      for (const [key, model] of provider.models) {
        const existing = merged.models.get(key)
        if (existing) {
          existing.label = model.label ?? existing.label
          existing.model = model.model ?? existing.model
          existing.env = { ...existing.env, ...model.env }
          continue
        }
        const holder = this.holders.get(key)
        if (holder !== undefined && holder !== id) {
          const holderProvider = this.providers.get(holder)!
          if (holderProvider.operator) {
            this.errors.push(`${file}: model "${key}" is already defined under provider "${holder}" (${holderProvider.originFile}); the nearer definition is ignored.`)
            continue
          }
          // Re-home: the key leaves the shipped provider (D2), carrying its
          // flattened settings below this provider's own overlay.
          const flat = flattenModel(holderProvider, holderProvider.models.get(key)!)
          holderProvider.models.delete(key)
          this.holders.set(key, id)
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
        this.holders.set(key, id)
        merged.models.set(key, { label: model.label, model: model.model, env: { ...model.env } })
      }
    }
  }

  /** Merge one parsed `profiles.json`: entries read as one-model providers (D3). */
  addProfiles(file: string, shipped: boolean, entries: Map<string, PartialProfile>): void {
    for (const [id, entry] of entries) {
      const provider = this.providers.get(id)
      if (provider) {
        this.mergeIntoProvider(provider, id, entry, shipped)
        continue
      }
      const holder = this.holders.get(id)
      if (holder !== undefined) {
        const holderProvider = this.providers.get(holder)!
        if (holderProvider.operator) {
          this.errors.push(`${file}: profile "${id}" is a model of provider "${holder}" (${holderProvider.originFile}); the entry is ignored.`)
          continue
        }
        // Re-home into a one-model provider over the shipped settings.
        const flat = flattenModel(holderProvider, holderProvider.models.get(id)!)
        holderProvider.models.delete(id)
        this.holders.delete(id)
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
          operator: !shipped,
          originFile: file,
        })
        this.holders.set(id, id)
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
        operator: !shipped,
        originFile: file,
      })
      this.holders.set(id, id)
    }
  }

  /** A legacy entry whose id names an existing provider merges into it. */
  private mergeIntoProvider(provider: MergedProvider, id: string, entry: PartialProfile, shipped: boolean): void {
    if (!shipped) provider.operator = true
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
      // Provider-level facts; a startup model with no matching model key
      // has no place to land and is dropped.
      provider.label = entry.label ?? provider.label
      provider.env = { ...provider.env, ...entry.env }
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
      this.holders.set('default', 'default')
      return
    }
    this.providers.set('default', {
      label: 'Default',
      env: {},
      models: new Map([['default', { label: 'Default', env: {} }]]),
      operator: false,
      originFile: '(implicit)',
    })
    this.holders.set('default', 'default')
  }
}
