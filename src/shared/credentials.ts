// Wire contract for /api/settings/credentials (provider-credential-store S5):
// the Settings credential listing and its mutations. Every read surface is
// value-free — name, kind, state, source, and marks only, never a value, a
// prefix, or a length — and every refusal or outcome carries fixed safe text.

export type CredentialKind = 'secret-source' | 'launch-env'

/** Where a listed variable's effective value comes from. The legacy Settings
 * map is never a source (OD-M9/M10 = b); the migration state names it. */
export type CredentialSource = 'store' | 'seed'

export interface CredentialListingRow {
  name: string
  /** The store entry's kind; null for a seed-only variable. */
  kind: CredentialKind | null
  /** Presence only: a blank exports the variable empty. */
  state: 'set' | 'blank'
  source: CredentialSource
  /** A store entry hides a value from the process env or the seed. */
  overriding: boolean
  /** A delivered-kind variable whose name is registered: stored but inert (W7/W8). */
  collision: boolean
}

/** The store as a whole; `reason` is a fixed code, `text` its fixed sentence. */
export type CredentialStoreState = { ok: true } | { ok: false; reason: string; text: string }

export interface CredentialMigrationState {
  /** `complete`: stamped; `pending`: the map awaits a durable store write; `none`: nothing to move. */
  state: 'complete' | 'pending' | 'none'
  /** Why a pending migration has not committed — fixed text, or null. */
  text: string | null
  /** Legacy Settings names not migrated because the store already held them. */
  skipped: string[]
  /** Legacy Settings names found after the migration stamp: neither migrated nor delivered. */
  ignored: string[]
}

export interface CredentialListing {
  store: CredentialStoreState
  rows: CredentialListingRow[]
  migration: CredentialMigrationState
}

/** PUT /api/settings/credentials/:name — set or replace ('' stores a blank). */
export interface CredentialSetRequest {
  value: string
  kind?: CredentialKind
}

/** POST /api/settings/credentials/:name/reclassify */
export interface CredentialReclassifyRequest {
  kind: CredentialKind
}

/** Every mutation's typed outcome; branch on `applied` first. */
export interface CredentialMutationOutcome {
  applied: boolean
  durable: boolean
  /** Fixed safe text describing the outcome. */
  message: string
  listing: CredentialListing
}

/** A refused request: a fixed code and its fixed sentence. */
export interface CredentialRefusal {
  code: string
  error: string
}
