// Worker selectors (dispatch-worker-choice D1): the worker a sender chose for
// group mail, stored in canonical form and resolved to the group's model keys
// at route time. Pure: the caller states the catalog as model key → provider
// id (Codex profiles included, under their home's provider id).
//
// Canonical form: a provider id, or `provider/model`. A bare id that is a
// provider is the provider; one that is only a model key becomes
// `provider/model`, so the stored value never depends on bare-id ambiguity
// later; one that is a provider and a model of a *different* provider is
// refused as ambiguous. A provider whose model shares its id is not ambiguous.

/** Every catalog model key with its provider id. */
export type WorkerCatalog = ReadonlyMap<string, string>

export type WorkerSelectorRefusal = 'malformed' | 'unknown' | 'ambiguous' | 'outside-group'

export type WorkerSelectorResult =
  | { ok: true; selector: string }
  | { ok: false; reason: WorkerSelectorRefusal; error: string }

const providersOf = (catalog: WorkerCatalog) => new Set(catalog.values())

function catalogSummary(catalog: WorkerCatalog): string {
  const providers = [...providersOf(catalog)].sort()
  return `the catalog's providers are ${providers.join(', ') || 'none'}, and its models ${[...catalog.keys()].sort().join(', ') || 'none'}`
}

/** Normalize a sender's `worker` against the catalog to its canonical selector. */
export function normalizeWorkerSelector(raw: string, catalog: WorkerCatalog): WorkerSelectorResult {
  const value = raw.trim()
  const parts = value.split('/')
  if (value === '' || parts.length > 2 || parts.some(part => part === '')) {
    return { ok: false, reason: 'malformed', error: `Worker "${raw}" is not a provider, a model key, or provider/model.` }
  }
  if (parts.length === 2) {
    const [provider, model] = parts as [string, string]
    if (catalog.get(model) === provider) return { ok: true, selector: value }
    return { ok: false, reason: 'unknown', error: `Worker "${value}" names no model ${model} of provider ${provider}; ${catalogSummary(catalog)}.` }
  }
  const isProvider = providersOf(catalog).has(value)
  const owner = catalog.get(value)
  if (isProvider && owner !== undefined && owner !== value) {
    return {
      ok: false, reason: 'ambiguous',
      error: `Worker "${value}" is both a provider and a model of provider ${owner}; use the provider/model form (${owner}/${value}).`,
    }
  }
  if (isProvider) return { ok: true, selector: value }
  if (owner !== undefined) return { ok: true, selector: `${owner}/${value}` }
  return { ok: false, reason: 'unknown', error: `Worker "${value}" names no provider or model; ${catalogSummary(catalog)}.` }
}

/**
 * The group's model keys a canonical selector chooses, in the group's order:
 * a provider's models the group lists, or the one `provider/model` when the
 * group lists it and that provider still owns it. Empty when none.
 */
export function resolveWorkerSelector(selector: string, groupProfiles: readonly string[], providerOf: (profileId: string) => string): string[] {
  const slash = selector.indexOf('/')
  if (slash >= 0) {
    const provider = selector.slice(0, slash)
    const model = selector.slice(slash + 1)
    return groupProfiles.includes(model) && providerOf(model) === provider ? [model] : []
  }
  return groupProfiles.filter(profileId => providerOf(profileId) === selector)
}

/**
 * The send-time check (D1, agent-mailbox spec): normalize against the catalog,
 * then require the choice to name one of the target group's workers.
 */
export function validateWorkerChoice(raw: string, catalog: WorkerCatalog, group: { id: string; profiles: readonly string[] }):
  WorkerSelectorResult & { profiles?: string[] } {
  const normalized = normalizeWorkerSelector(raw, catalog)
  if (!normalized.ok) return normalized
  const providerOf = (profileId: string) => catalog.get(profileId) ?? profileId
  const profiles = resolveWorkerSelector(normalized.selector, group.profiles, providerOf)
  if (profiles.length === 0) {
    const workers = group.profiles.map(profileId => `${providerOf(profileId)}/${profileId}`).join(', ') || 'none'
    return { ok: false, reason: 'outside-group', error: `Worker "${normalized.selector}" is not among group ${group.id}'s workers: ${workers}.` }
  }
  return { ...normalized, profiles }
}
