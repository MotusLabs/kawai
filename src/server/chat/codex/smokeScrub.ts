/**
 * Fixture hygiene for the Codex smoke recording (task rev 3): identifying
 * values never reach a recorded fixture. Identifying keys become fixed
 * placeholders, every scratch workspace collapses to one fixture path, and
 * the home directory prefix is rewritten, before a record is written.
 * scripts/codex-smoke.ts applies this at record time; the committed
 * fixture's hygiene test (codexSmokeFixtureHygiene.test.ts) re-checks the
 * committed fixture against the same constants, so a new recording cannot
 * reintroduce a leak.
 */

export const SMOKE_SCRUB_STRINGS: Record<string, string> = {
  serverName: 'smoke-host',
  installationId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  orgId: '00000000-0000-4000-8000-000000000004',
  email: 'user@example.internal',
}
export const SMOKE_FIXTURE_WORKSPACE = '/tmp/kawai-codex-smoke-fixture'
export const SMOKE_FIXTURE_HOME = '/home/smoke'

const SCRATCH_WORKSPACE = /\/tmp\/kawai-codex-smoke-[0-9A-Za-z._-]+/g
const HOME_PATH = /\/home\/[0-9A-Za-z._-]+/g

/** Deep rewrite of one parsed JSON-RPC value; strings by key, then by shape. */
export function scrubSmokeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(SCRATCH_WORKSPACE, SMOKE_FIXTURE_WORKSPACE).replace(HOME_PATH, SMOKE_FIXTURE_HOME)
  }
  if (Array.isArray(value)) return value.map(scrubSmokeValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = typeof entry === 'string' && key in SMOKE_SCRUB_STRINGS
        ? SMOKE_SCRUB_STRINGS[key]
        : scrubSmokeValue(entry)
    }
    return out
  }
  return value
}

/** One record, scrubbed and reduced to the fixture's `{dir, line}` shape. */
export function scrubRawLine(raw: { dir: 'in' | 'out'; line: string }): { dir: 'in' | 'out'; line: string } {
  try {
    return { dir: raw.dir, line: JSON.stringify(scrubSmokeValue(JSON.parse(raw.line))) }
  } catch {
    // A torn line stays raw, with the path rules still applied to its text.
    return {
      dir: raw.dir,
      line: raw.line.replace(SCRATCH_WORKSPACE, SMOKE_FIXTURE_WORKSPACE).replace(HOME_PATH, SMOKE_FIXTURE_HOME),
    }
  }
}
