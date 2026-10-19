// Tier merge for the layered catalog (design D2/D3): provider files first,
// farthest level first, then the legacy `profiles.json` entries of each
// level. Same-id providers merge with the nearer scalar winning and env
// merging per key. A model key defined under two providers of different
// operator levels is an error naming both, the nearer definition ignored;
// a nearer definition of a SHIPPED model key re-homes instead, starting
// from the shipped model's flattened settings, so an existing project
// override keeps its launch settings. Legacy entries read as one-model
// providers (D3) unless their id names an existing provider. A provider
// holding credential variable names from a trusted file has its route fixed
// by the trusted tiers (openrouter-provider D2): a project file that would
// set its base URL, or move one of its models elsewhere, is ignored whole.
import type { ParsedProvider, PartialProfile } from './profileCatalog'

/** The settings a re-homed model carries from the shipped provider it left. */
export interface InheritedSettings {
  env: Record<string, string>
  label?: string
  model?: string
  executable?: string
  limitResetTimeZone?: string
  authTokenEnv?: string
  balanceKeyEnv?: string
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
  /** Credential variable names; only trusted files set them. */
  authTokenEnv?: string
  balanceKeyEnv?: string
  models: Map<string, MergedModel>
  /** An operator file introduced this provider; overlays never change it (F2). */
  operatorOrigin: boolean
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
  authTokenEnv?: string
  balanceKeyEnv?: string
} {
  return {
    label: model.label ?? model.inherited?.label ?? provider.label,
    model: model.model ?? model.inherited?.model,
    env: { ...model.inherited?.env, ...provider.env, ...model.env },
    executable: provider.executable ?? model.inherited?.executable,
    limitResetTimeZone: provider.limitResetTimeZone ?? model.inherited?.limitResetTimeZone,
    authTokenEnv: provider.authTokenEnv ?? model.inherited?.authTokenEnv,
    balanceKeyEnv: provider.balanceKeyEnv ?? model.inherited?.balanceKeyEnv,
  }
}

/** Whether a provider, or a model it took over, names a credential variable. */
export function providerCredentialed(provider: MergedProvider): boolean {
  if (provider.authTokenEnv !== undefined || provider.balanceKeyEnv !== undefined) return true
  for (const model of provider.models.values()) {
    if (model.inherited?.authTokenEnv !== undefined || model.inherited?.balanceKeyEnv !== undefined) return true
  }
  return false
}

/** The settings a re-homed model carries away from the provider it left. */
function inheritedFrom(flat: ReturnType<typeof flattenModel>): InheritedSettings {
  return {
    env: flat.env,
    label: flat.label,
    model: flat.model,
    executable: flat.executable,
    limitResetTimeZone: flat.limitResetTimeZone,
    authTokenEnv: flat.authTokenEnv,
    balanceKeyEnv: flat.balanceKeyEnv,
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

  /**
   * Merge one parsed `providers.json` (design D2, rev 5 table): pass one
   * applies every provider's facts (P1/P2 — an overlay merges into either
   * tier by D2's rules and reaches every key the provider holds, while the
   * tier stays what the introducing file set); pass two then places every
   * model key (P3) against those merged facts, so JSON key order never
   * changes an outcome and a re-home carries its own level's overlay.
   */
  addProviders(file: string, shipped: boolean, providers: Map<string, ParsedProvider>, trusted = shipped): void {
    if (!trusted) {
      const refusal = this.untrustedProviderRefusal(file, providers)
      if (refusal) {
        this.errors.push(refusal)
        return
      }
    }
    for (const [id, provider] of providers) {
      const merged = this.providers.get(id)
      if (!merged) {
        // P1: a new provider takes the introducing file's tier.
        this.providers.set(id, {
          label: provider.label,
          env: { ...provider.env },
          executable: provider.executable,
          limitResetTimeZone: provider.limitResetTimeZone,
          authTokenEnv: provider.authTokenEnv,
          balanceKeyEnv: provider.balanceKeyEnv,
          models: new Map(),
          operatorOrigin: !shipped,
          originFile: file,
        })
        continue
      }
      // P2: the overlay's facts merge by D2's rules into either tier.
      merged.label = provider.label ?? merged.label
      merged.env = { ...merged.env, ...provider.env }
      merged.executable = provider.executable ?? merged.executable
      merged.limitResetTimeZone = provider.limitResetTimeZone ?? merged.limitResetTimeZone
      merged.authTokenEnv = provider.authTokenEnv ?? merged.authTokenEnv
      merged.balanceKeyEnv = provider.balanceKeyEnv ?? merged.balanceKeyEnv
    }
    for (const [id, provider] of providers) {
      const merged = this.providers.get(id)!
      for (const [key, model] of provider.models) {
        const existing = merged.models.get(key)
        if (existing) {
          // P3: the key is already this provider's; it merges.
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
            inherited: inheritedFrom(flat),
          })
          continue
        }
        // P3: a new key joins X with X's merged facts plus its own — the
        // flatten applies this provider's (already overlaid) env.
        this.setHolder(key, { provider: id, operator: !shipped, originFile: file, own: false })
        merged.models.set(key, { label: model.label, model: model.model, env: { ...model.env } })
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
  addProfiles(file: string, shipped: boolean, entries: Map<string, PartialProfile>, trusted = shipped): void {
    if (!trusted) {
      const refusal = this.untrustedProfilesRefusal(file, entries)
      if (refusal) {
        this.errors.push(refusal)
        return
      }
    }
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
            inherited: { ...inheritedFrom(flat), executable: undefined, limitResetTimeZone: undefined },
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

  /**
   * D2 for a project `providers.json`, checked before anything merges so key
   * order never matters: the file may not set a credentialed provider's base
   * URL, nor re-home a model a credentialed provider holds.
   */
  private untrustedProviderRefusal(file: string, providers: Map<string, ParsedProvider>): string | undefined {
    for (const [id, provider] of providers) {
      const merged = this.providers.get(id)
      if (merged && providerCredentialed(merged) && 'ANTHROPIC_BASE_URL' in provider.env) {
        return routeRefusal(file, id)
      }
      for (const key of provider.models.keys()) {
        const holder = this.holders.get(key)
        if (holder === undefined || holder.provider === id || holder.operator) continue
        if (this.keyCredentialed(holder.provider, key)) return rehomeRefusal(file, key, holder.provider)
      }
    }
    return undefined
  }

  /** D2 for a project `profiles.json`: the same two refusals, by entry id. */
  private untrustedProfilesRefusal(file: string, entries: Map<string, PartialProfile>): string | undefined {
    for (const [id, entry] of entries) {
      const holder = this.holders.get(id)
      if (holder !== undefined) {
        if (!this.keyCredentialed(holder.provider, id)) continue
        if (holder.own) {
          if ('ANTHROPIC_BASE_URL' in entry.env) return routeRefusal(file, holder.provider)
          continue
        }
        if (!holder.operator) return rehomeRefusal(file, id, holder.provider)
        continue
      }
      const provider = this.providers.get(id)
      if (provider?.operatorOrigin && providerCredentialed(provider) && 'ANTHROPIC_BASE_URL' in entry.env) {
        return routeRefusal(file, id)
      }
    }
    return undefined
  }

  private keyCredentialed(providerId: string, key: string): boolean {
    const provider = this.providers.get(providerId)!
    const flat = flattenModel(provider, provider.models.get(key)!)
    return flat.authTokenEnv !== undefined || flat.balanceKeyEnv !== undefined
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
    if (this.holders.has('default')) {
      this.enforceTrustedCredentialInvariants()
      return
    }
    const provider = this.providers.get('default')
    if (provider) {
      provider.models.set('default', { label: 'Default', env: {} })
      this.setHolder('default', { provider: 'default', operator: false, originFile: '(implicit)', own: true })
    } else {
      this.providers.set('default', {
        label: 'Default',
        env: {},
        models: new Map([['default', { label: 'Default', env: {} }]]),
        operatorOrigin: false,
        originFile: '(implicit)',
      })
      this.setHolder('default', { provider: 'default', operator: false, originFile: '(implicit)', own: true })
    }
    this.enforceTrustedCredentialInvariants()
  }

  /**
   * D2's trusted-tier invariants, on the merged tiers (openrouter-provider):
   * a credentialed provider takes a non-empty base URL from a trusted tier —
   * the key always has one known destination — and no credentialed model
   * carries an executable, so no wrapper ever chooses where the key goes.
   * Checked here because both facts can be assembled across the two trusted
   * files (an executable arriving through a profiles.json entry, a base URL
   * supplied by the sibling file). A provider breaking either is dropped
   * whole, naming it: fail-closed, no session launches through an unknown
   * route or a wrapper with the key, and every other provider stays usable.
   */
  private enforceTrustedCredentialInvariants(): void {
    // Deleting from a Map during for…of iteration is safe, so no array copy.
    for (const [id, provider] of this.providers) {
      const credentialedModels = [...provider.models.values()]
        .map(model => flattenModel(provider, model))
        .filter(flat => flat.authTokenEnv !== undefined || flat.balanceKeyEnv !== undefined)
      if (credentialedModels.length === 0) continue
      // The flattened env is the truth: a re-homed model can carry the base
      // URL in its inherited settings when the provider's own env lacks it.
      if (credentialedModels.some(flat => !flat.env.ANTHROPIC_BASE_URL)) {
        this.providers.delete(id)
        this.errors.push(`${provider.originFile}: provider "${id}" names credential variables, but no trusted tier gives it a non-empty ANTHROPIC_BASE_URL; the provider is dropped so its key cannot leave for an unknown destination.`)
        continue
      }
      if (provider.executable !== undefined || credentialedModels.some(flat => flat.executable !== undefined)) {
        this.providers.delete(id)
        this.errors.push(`${provider.originFile}: provider "${id}" has credential variables and must not set executable; the wrapper would choose where the key is sent. The provider is dropped.`)
      }
    }
  }
}

function routeRefusal(file: string, providerId: string): string {
  return `${file}: provider "${providerId}" has credential variables from a trusted catalog, so a project file may not set its ANTHROPIC_BASE_URL; the file is ignored.`
}

function rehomeRefusal(file: string, key: string, providerId: string): string {
  return `${file}: model "${key}" belongs to provider "${providerId}", which has credential variables from a trusted catalog, so a project file may not move it to another provider; the file is ignored.`
}
