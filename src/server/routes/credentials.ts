// Settings credential routes (provider-credential-store S5, table U), mounted
// at /api/settings/credentials. Write-only: GET lists metadata (name, kind,
// state, source, marks) and never a value, prefix, or length; PUT sets or
// replaces one variable (a blank stores a blank), DELETE clears it, POST
// …/reclassify changes its kind. Every mutation returns the store's typed
// outcome (applied, durable) with fixed safe text, and every refusal a fixed
// code and sentence — never a parser message, an fs error, a cause, or the
// raw input echoed back as a name. Nothing here logs a request body. The
// mutations wait for the startup migration to settle first, so the
// migration's one write and an operator's write never race for a name.
import { Hono, type Context } from 'hono'
import type {
  CredentialKind,
  CredentialListing,
  CredentialMigrationState,
  CredentialMutationOutcome,
  CredentialRefusal,
} from '../../shared/credentials'
import type { CredentialComposition } from '../chat/credentialComposition'
import { CredentialStoreError, type CredentialSetOutcome, type CredentialStore } from '../chat/credentialStore'
import { logger } from '../logger'

export interface CredentialRoutesDeps {
  store: CredentialStore
  composition: CredentialComposition
  /** The registered-name set now (catalog, store keys, retained). */
  registered: () => ReadonlySet<string>
  /** The migration's state for the listing. */
  migration: () => CredentialMigrationState
  /** Settles when the startup migration finished (either way). */
  ready?: Promise<unknown>
}

const REFUSAL_TEXT: Record<string, { status: 400 | 409 | 500; text: string }> = {
  'invalid-body': { status: 400, text: 'The request body is not a valid credential request.' },
  'invalid-name': { status: 400, text: 'The variable name is not a valid environment variable name.' },
  'name-not-catalog': { status: 400, text: 'A secret source needs an upper-case name (A-Z, 0-9, _), like a catalog binding.' },
  'invalid-kind': { status: 400, text: 'The kind must be secret-source or launch-env.' },
  'invalid-value': { status: 400, text: 'The value must be a string.' },
  'value-nul': { status: 400, text: 'The value contains a NUL character and was not stored.' },
  'retain-collaborator-required': { status: 500, text: 'The credential registry is unavailable; nothing was stored.' },
  'retain-collaborator-failed': { status: 500, text: 'The credential registry could not record the name; nothing was stored.' },
  'write-failed': { status: 500, text: 'The user credential store could not be written; the previous contents stand.' },
  malformed: { status: 409, text: 'The user credential store is malformed; repair or remove it by hand. Nothing was changed.' },
  unreadable: { status: 409, text: 'The user credential store cannot be read. Nothing was changed.' },
  'unsafe-permissions': { status: 409, text: 'The user credential store grants group or other access; restrict it to 0600. Nothing was changed.' },
  symlink: { status: 409, text: 'The user credential store path is a symbolic link and is refused. Nothing was changed.' },
  'not-regular-file': { status: 409, text: 'The user credential store path is not a regular file. Nothing was changed.' },
  'foreign-owner': { status: 409, text: 'The user credential store is owned by another user. Nothing was changed.' },
  'identity-changed': { status: 409, text: 'The user credential store changed while it was read. Nothing was changed.' },
}
const UNKNOWN = { status: 500 as const, text: 'The credential request failed. Nothing was changed.' }

export const OUTCOME_TEXT = {
  durable: 'Saved. It applies at the next agent launch.',
  notDurable: 'Saved, but the store could not confirm the write reached the disk. It applies at the next agent launch; do not retry — check the filesystem.',
  unchanged: 'Nothing changed.',
} as const

function outcomeText(outcome: CredentialSetOutcome): string {
  if (!outcome.applied) return OUTCOME_TEXT.unchanged
  return outcome.durable ? OUTCOME_TEXT.durable : OUTCOME_TEXT.notDurable
}

const KINDS: readonly string[] = ['secret-source', 'launch-env']

export function createCredentialRoutes(deps: CredentialRoutesDeps): Hono {
  const routes = new Hono()
  const listing = (): CredentialListing => deps.composition.listing(deps.registered(), deps.migration())

  const refuse = (c: Context, code: string) => {
    const known = REFUSAL_TEXT[code] ?? UNKNOWN
    // The code only: never the body, the name, or an error message.
    logger.warn('credential_request_refused', { code: REFUSAL_TEXT[code] ? code : 'unknown' })
    const body: CredentialRefusal = { code: REFUSAL_TEXT[code] ? code : 'failed', error: known.text }
    return c.json(body, known.status)
  }

  const mutate = async (c: Context, run: () => Promise<CredentialSetOutcome>) => {
    await deps.ready?.catch(() => undefined)
    let outcome: CredentialSetOutcome
    try {
      outcome = await run()
    } catch (error) {
      return refuse(c, error instanceof CredentialStoreError ? error.code : 'unknown')
    }
    const body: CredentialMutationOutcome = {
      applied: outcome.applied, durable: outcome.durable, message: outcomeText(outcome), listing: listing(),
    }
    return c.json(body)
  }

  const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await c.req.json()
      return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
    } catch {
      return null
    }
  }

  routes.get('/', (c) => c.json(listing()))

  routes.put('/:name', async (c) => {
    const body = await readJson(c)
    if (!body) return refuse(c, 'invalid-body')
    const kind = body.kind ?? 'launch-env'
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return refuse(c, 'invalid-kind')
    if (typeof body.value !== 'string') return refuse(c, 'invalid-value')
    const value = body.value
    return mutate(c, () => deps.store.set(c.req.param('name'), value, kind as CredentialKind))
  })

  routes.delete('/:name', (c) => mutate(c, () => deps.store.clear(c.req.param('name'))))

  routes.post('/:name/reclassify', async (c) => {
    const body = await readJson(c)
    if (!body) return refuse(c, 'invalid-body')
    if (typeof body.kind !== 'string' || !KINDS.includes(body.kind)) return refuse(c, 'invalid-kind')
    const kind = body.kind as CredentialKind
    return mutate(c, () => deps.store.reclassify(c.req.param('name'), kind))
  })

  return routes
}

/** The mount point; the retired /api/settings/chat-provider-env is never mounted (U7). */
export const CREDENTIALS_ROUTE = '/api/settings/credentials'

/** Mount the credential routes on the server app, as bootstrap does. */
export function mountCredentialRoutes(app: Hono, deps: CredentialRoutesDeps): void {
  app.route(CREDENTIALS_ROUTE, createCredentialRoutes(deps))
}
