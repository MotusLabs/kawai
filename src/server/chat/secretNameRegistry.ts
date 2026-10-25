// The secret-name registry (provider-relay-setup D2, table W): the one
// registered-name set every launch withholds. It unions the credential
// variables named at any parsed catalog layer (any entry state — removal,
// disabling, or clearing never stops withholding), every header variable
// (§4's source, empty until headers land), every secret-source store key
// (§2's source, empty until the store lands), and the retained names — every
// name ever registered, persisted as names only in app_settings. Names are
// not secrets: the persisted row never holds a value.
import type { ProfileCatalog } from './profileCatalog'

/** The app_settings key holding the retained names (names only). */
export const RETAINED_SECRET_NAMES_KEY = 'registered_secret_names'

/** The persistence seam: the two app_settings operations the registry needs. */
export interface RetainedNamesDb {
  getAppSetting(key: string): string | null
  setAppSetting(key: string, value: string): void
}

/** The registered-name sources (table W). Catalog layers always contribute;
 * headers and store keys are explicit sources that are empty until §4/§2. */
export interface SecretNameSources {
  /** Credential variables named at any parsed catalog layer, any entry state. */
  catalogNames?: Iterable<string>
  /** Header variables bound by trusted providers (§4). */
  headerVariables?: Iterable<string>
  /** Secret-source store keys (§2). */
  secretSourceKeys?: Iterable<string>
  /** Names read back from the persisted retained set. */
  retainedNames?: Iterable<string>
}

/** The one registered-name set: the union of every source (table W). */
export function registeredSecretNames(sources: SecretNameSources): Set<string> {
  const names = new Set<string>()
  for (const source of [sources.catalogNames, sources.headerVariables, sources.secretSourceKeys, sources.retainedNames]) {
    if (source === undefined) continue
    for (const name of source) names.add(name)
  }
  return names
}

/**
 * The retained names read back from `app_settings`. A malformed value reads
 * as empty with a warning naming the key — the set is non-secret bookkeeping
 * re-derivable from the live catalogs, so a damaged key never blocks a
 * launch; the next observation heals it to the live union. Names that only
 * the damaged row held are gone with it: the honest limit of heal-on-malformed.
 */
export function readRetainedNames(db: RetainedNamesDb): Set<string> {
  const stored = db.getAppSetting(RETAINED_SECRET_NAMES_KEY)
  if (stored === null) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    console.warn(`[agentboard] ${RETAINED_SECRET_NAMES_KEY} is not valid JSON; treating the retained names as empty until the next registration rewrites them.`)
    return new Set()
  }
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== 'string')) {
    console.warn(`[agentboard] ${RETAINED_SECRET_NAMES_KEY} is not a list of names; treating the retained names as empty until the next registration rewrites them.`)
    return new Set()
  }
  return new Set(parsed as string[])
}

/**
 * Observe the sources and return the full registered set: the persisted
 * retained names unioned with everything the sources name. New names are
 * persisted immediately (one write per growth) — a name seen by any launch
 * survives its entry's later removal. A failed write is logged and never
 * fails the caller: the launch filters with the in-memory union either way.
 */
export function observeRegisteredNames(
  db: RetainedNamesDb,
  sources: Omit<SecretNameSources, 'retainedNames'>
): Set<string> {
  const retained = readRetainedNames(db)
  const names = registeredSecretNames({ ...sources, retainedNames: retained })
  // names always ⊇ retained; equal sizes mean nothing new was observed.
  if (names.size <= retained.size) return names
  try {
    db.setAppSetting(RETAINED_SECRET_NAMES_KEY, JSON.stringify([...names]))
  } catch (error) {
    console.error(`[agentboard] Could not persist ${RETAINED_SECRET_NAMES_KEY} (${names.size} names): ${error instanceof Error ? error.message : String(error)}`)
  }
  return names
}

/**
 * Table W7's collision data: the registered names a delivery composition
 * (process env, seed, Settings map — §2's launch-env entries later) carries.
 * Names only, never values. The launch filter withholds them silently; the
 * source listing (§7) and the store write paths (§2) render and report this
 * list. Dormant until §7 wires it.
 */
export function collidingLaunchEnvNames(
  deliveryEnv: Record<string, string | undefined>,
  registered: ReadonlySet<string>
): string[] {
  return [...registered].filter(name => name in deliveryEnv).sort()
}

/**
 * The typed pre-spawn refusal (provider-relay-setup correction B): a launch
 * branch whose mandatory composition would carry a registered name — a
 * controlled setting, a transport pin, a credential blank, or the Codex
 * home — refuses instead of delivering the name under its own composition.
 * Names only, never values; the caller settles the send failed with this
 * error's message and no child starts.
 */
export class RegisteredNameRefusal extends Error {
  constructor(
    /** The launch branch that would have composed the names. */
    readonly branch: string,
    /** The registered names the branch would have composed, sorted. */
    readonly names: string[]
  ) {
    super(
      `Registered secret name(s) ${names.join(', ')} cannot be launched on the ${branch} branch: ` +
      `that branch must compose them (controlled setting, transport pin, or credential blank) to ` +
      `protect the credential, and a registered name is never composed. Remove or rename the ` +
      `variable in the catalog — the name itself stays withheld once registered.`
    )
    this.name = 'RegisteredNameRefusal'
  }
}

/** The registered set for a resolved catalog: its parsed-layer names plus
 * whatever the persisted retained set holds (headers and store keys remain
 * explicit, empty sources until §4/§2 plug in — the filter is unchanged). */
export function catalogRegisteredNames(
  db: RetainedNamesDb | undefined,
  catalog: Pick<ProfileCatalog, 'credentialNames'>
): Set<string> {
  if (db === undefined) return registeredSecretNames({ catalogNames: catalog.credentialNames })
  return observeRegisteredNames(db, { catalogNames: catalog.credentialNames })
}
