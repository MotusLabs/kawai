// The credential composition owner (provider-credential-store S3): one per
// server, built at bootstrap over the one production credential store. Per
// variable, *resolution* — what the auth gate, injection, the availability
// probe, and provider usage pulls read — is process env < AGENTBOARD_CHAT_ENV
// seed < (the legacy Settings map, only until its migration commits) < store,
// any kind, a blank exporting empty and an absent entry passing through; an
// unreadable, unsafe, or malformed store composes as absent. *Delivery* —
// what a launch receives — is resolution minus every registered name (the
// registry, which this module feeds with the store's secret-source keys).
// The seed's old wholesale replacement (`current()` returning override-or-
// seed) is retired: composition is per variable, never wholesale.
import type {
  CredentialListing,
  CredentialListingRow,
  CredentialMigrationState,
  CredentialStoreState,
} from '../../shared/credentials'
import type { ChatProviderEnv } from './chatProviderEnv'
import os from 'node:os'
import path from 'node:path'
import { createCredentialStore, type CredentialStore } from './credentialStore'
import { retainSecretName, type RetainedNamesDb } from './secretNameRegistry'

type Env = Record<string, string | undefined>

/** Resolution: the overrides merged per variable over the process env. */
export function resolutionEnv(overrides: ChatProviderEnv, processEnv: Env = process.env): Env {
  return { ...processEnv, ...overrides }
}

/** Delivery: a copy of a resolution without any registered name (table W). */
export function deliveryEnv(resolution: Env, registered: ReadonlySet<string>): Env {
  const delivered = { ...resolution }
  for (const name of registered) delete delivered[name]
  return delivered
}

const STORE_TEXT: Record<string, string> = {
  malformed: 'The user credential store is malformed; repair or remove it by hand. Lower sources apply meanwhile.',
  unreadable: 'The user credential store cannot be read. Lower sources apply meanwhile.',
  'unsafe-permissions': 'The user credential store grants group or other access; restrict it to the owner (0600). Lower sources apply meanwhile.',
  symlink: 'The user credential store path is a symbolic link and is refused. Lower sources apply meanwhile.',
  'not-regular-file': 'The user credential store path is not a regular file. Lower sources apply meanwhile.',
  'foreign-owner': 'The user credential store is owned by another user and is refused. Lower sources apply meanwhile.',
  'identity-changed': 'The user credential store changed while it was read. Lower sources apply meanwhile.',
}

/** The fixed sentence for a store status reason; unknown codes get a generic one. */
export function storeReasonText(reason: string): string {
  return STORE_TEXT[reason] ?? 'The user credential store is unavailable. Lower sources apply meanwhile.'
}

export interface CredentialCompositionOptions {
  store: CredentialStore
  /** The parsed AGENTBOARD_CHAT_ENV seed. */
  seed: ChatProviderEnv
  /** The legacy Settings map while its migration is uncommitted; null after. */
  legacy?: () => ChatProviderEnv | null
  /** The process environment; injected in tests. */
  processEnv?: () => Env
}

export class CredentialComposition {
  constructor(private readonly options: CredentialCompositionOptions) {}

  /** The per-variable overrides above the process env: seed < legacy < store. */
  overrides(): ChatProviderEnv {
    const merged: ChatProviderEnv = { ...this.options.seed, ...this.options.legacy?.() }
    const { status, entries } = this.options.store.list()
    if (!status.ok) return merged
    for (const entry of entries) {
      const value = this.options.store.resolve(entry.name)
      if (value !== undefined) merged[entry.name] = value
    }
    return merged
  }

  /** The registry's store source: every secret-source key, names only. */
  secretSourceKeys(): string[] {
    const { status, entries } = this.options.store.list()
    return status.ok ? entries.filter(entry => entry.kind === 'secret-source').map(entry => entry.name) : []
  }

  /** The Settings credential listing (S4): metadata only, never a value. */
  listing(registered: ReadonlySet<string>, migration: CredentialMigrationState): CredentialListing {
    const listed = this.options.store.list()
    const processEnv = this.options.processEnv?.() ?? process.env
    const seed = this.options.seed
    const legacy = this.options.legacy?.() ?? {}
    const rows = new Map<string, CredentialListingRow>()
    const lower = (name: string, source: 'seed' | 'legacy-settings', value: string) =>
      rows.set(name, { name, kind: null, state: value === '' ? 'blank' : 'set', source, overriding: false, collision: registered.has(name) })
    for (const [name, value] of Object.entries(seed)) lower(name, 'seed', value)
    for (const [name, value] of Object.entries(legacy)) lower(name, 'legacy-settings', value)
    for (const entry of listed.entries) {
      rows.set(entry.name, {
        name: entry.name,
        kind: entry.kind,
        state: entry.state,
        source: 'store',
        overriding: processEnv[entry.name] !== undefined || Object.hasOwn(seed, entry.name) || Object.hasOwn(legacy, entry.name),
        collision: entry.kind === 'launch-env' && registered.has(entry.name),
      })
    }
    const status = listed.status
    const store: CredentialStoreState = status.ok || status.reason === 'missing'
      ? { ok: true }
      : { ok: false, reason: status.reason, text: storeReasonText(status.reason) }
    return { store, rows: [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), migration }
  }
}

/**
 * The production store path (S2): the catalogs' HOME precedence
 * (`profileCatalogLevels`) — an explicit home, else `process.env.HOME`, else
 * `os.homedir()` — so the store and the catalogs never split across two
 * homes. (The core's `defaultCredentialStorePath()` keeps `os.homedir()`,
 * which Bun fixes at startup; production never calls it.)
 */
export function credentialStorePath(homeDir?: string): string {
  return path.join(homeDir ?? process.env.HOME ?? os.homedir(), '.kawai', 'credentials.json')
}

/**
 * The one production store (S1, S2): `<HOME>/.kawai/credentials.json` under
 * the catalogs' HOME rule, with the mandatory SQLite retain collaborator —
 * construction without it is a startup error, never a silent no-op.
 */
export function createProductionCredentialStore(db: RetainedNamesDb | undefined, homeDir?: string): CredentialStore {
  if (!db) throw new Error('The credential store needs the retained-names registry; refusing to start without it.')
  return createCredentialStore(credentialStorePath(homeDir), {
    retainSecretNames: { retainSecretName: name => retainSecretName(db, name) },
  })
}

/** The server's credentials: the one store and the composition over it. */
export interface ServerCredentials {
  store: CredentialStore
  composition: CredentialComposition
}

/** Built once at bootstrap (and identically by the wiring tests). */
export function createServerCredentials(options: {
  db: RetainedNamesDb
  seed: ChatProviderEnv
  homeDir?: string
  legacy?: () => ChatProviderEnv | null
}): ServerCredentials {
  const store = createProductionCredentialStore(options.db, options.homeDir)
  const composition = new CredentialComposition({
    store, seed: options.seed, ...(options.legacy ? { legacy: options.legacy } : {}),
  })
  return { store, composition }
}

/** The chat manager's two credential getters (S3): resolution's overrides
 * and the registry's store-key source, both read afresh per call. */
export function credentialManagerOptions(composition: CredentialComposition): {
  getProviderEnv: () => ChatProviderEnv
  getSecretSourceKeys: () => string[]
} {
  return {
    getProviderEnv: () => composition.overrides(),
    getSecretSourceKeys: () => composition.secretSourceKeys(),
  }
}
