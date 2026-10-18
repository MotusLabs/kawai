// Fixture hygiene for the Codex smoke transcript (task rev 3, review O1).
// The recording script scrubs at write time (smokeScrub.ts); this test
// re-checks the committed fixture against the same rules independently, so
// no identifying value can reach a commit: identity keys hold their fixed
// placeholders, no real hostname or username substring appears anywhere,
// UUID-shaped ids ride only their allowlisted keys, URL hosts stay on the
// reserved example, and paths stay inside the placeholder prefixes.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SMOKE_FIXTURE_HOME,
  SMOKE_FIXTURE_WORKSPACE,
  SMOKE_SCRUB_STRINGS,
} from '../chat/codex/smokeScrub'

const FIXTURE_DIR = path.resolve(import.meta.dir, '..', 'chat', 'codex', '__fixtures__')
const HOME_SEGMENT = /\/home\/([0-9A-Za-z._-]+)/g
const SCRATCH_SEGMENT = /\/tmp\/kawai-codex-smoke-([0-9A-Za-z._-]+)/g
const UUID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const URL_HOST_SEGMENT = /https?:\/\/([^/:?\s"]+)/g
/** The only host a recorded URL may name (the scrub's own placeholder). */
const URL_HOST_ALLOWLIST = new Set(['example.internal'])
/**
 * Keys whose values legitimately carry UUID-shaped ids (a `*Cursor` is one
 * too). A UUID anywhere else — free text, aggregatedOutput, a new id-shaped
 * key — fails, because only the listed keys are known to be session-scoped.
 */
const UUID_BEARING_KEYS = new Set([
  'id', 'threadId', 'turnId', 'rootTurnId', 'itemId', 'callId',
  'sessionId', 'revision', 'path',
])
const PLACEHOLDER_UUIDS = new Set(
  Object.values(SMOKE_SCRUB_STRINGS).filter((value) => UUID_SHAPE.test(value)),
)

// A real host or username leaking into any recorded string must fail. A
// username shorter than five characters (root, ci, git) is too generic for
// a substring rule — git prints "(root-commit)" — so only longer, personal
// usernames are scanned.
const HOSTNAME = os.hostname()
let USERNAME = ''
try {
  USERNAME = os.userInfo().username
} catch {
  // No passwd entry for this uid: the username scan cannot run here.
}
const SCAN_USERNAME = USERNAME.length >= 5

const violations: string[] = []

function check(where: string, scrubKey: string, key: string, value: unknown): void {
  if (typeof value === 'string') {
    // Any string under an identifying key must be its fixed placeholder.
    if (scrubKey && value !== SMOKE_SCRUB_STRINGS[scrubKey]) {
      violations.push(`${where}: ${scrubKey} holds a non-placeholder value`)
    }
    if (HOSTNAME && value.includes(HOSTNAME)) violations.push(`${where}: hostname substring`)
    if (SCAN_USERNAME && value.includes(USERNAME)) violations.push(`${where}: username substring`)
    for (const match of value.matchAll(HOME_SEGMENT)) {
      if (`/home/${match[1]}` !== SMOKE_FIXTURE_HOME) violations.push(`${where}: home path ${match[0]}`)
    }
    for (const match of value.matchAll(SCRATCH_SEGMENT)) {
      if (`/tmp/kawai-codex-smoke-${match[1]}` !== SMOKE_FIXTURE_WORKSPACE) {
        violations.push(`${where}: scratch workspace ${match[0]}`)
      }
    }
    for (const match of value.matchAll(UUID_SEGMENT)) {
      if (PLACEHOLDER_UUIDS.has(match[0])) continue
      if (!UUID_BEARING_KEYS.has(key) && !key.endsWith('Cursor')) {
        violations.push(`${where}: UUID under unlisted key "${key}"`)
      }
    }
    for (const match of value.matchAll(URL_HOST_SEGMENT)) {
      if (!URL_HOST_ALLOWLIST.has(match[1].toLowerCase())) {
        violations.push(`${where}: URL host ${match[1]}`)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => check(`${where}[${index}]`, scrubKey, key, entry))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [entryKey, entry] of Object.entries(value)) {
      // The scrub key follows the nearest identifying ancestor; the UUID
      // allowlist reads the immediate key only.
      check(
        `${where}.${entryKey}`,
        entryKey in SMOKE_SCRUB_STRINGS ? entryKey : scrubKey,
        entryKey,
        entry,
      )
    }
  }
}

describe('codex smoke fixture hygiene', () => {
  test('every record parses, nested JSON-RPC included, and holds no identifying value', () => {
    const lines = fs.readFileSync(path.join(FIXTURE_DIR, 'smoke-transcript.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const [index, line] of lines.entries()) {
      const record = JSON.parse(line) as { dir: string; line: string }
      expect(['in', 'out']).toContain(record.dir)
      let message: unknown
      try {
        message = JSON.parse(record.line)
      } catch {
        violations.push(`record ${index}: unparsable nested JSON-RPC line`)
        continue
      }
      check(`record ${index}`, '', '', message)
    }
    expect(violations).toEqual([])
  })

  test('the README names no home or scratch path beyond the placeholders', () => {
    const readme = fs.readFileSync(path.join(FIXTURE_DIR, 'README.md'), 'utf8')
    for (const match of readme.matchAll(HOME_SEGMENT)) {
      expect(`/home/${match[1]}`).toBe(SMOKE_FIXTURE_HOME)
    }
    for (const match of readme.matchAll(SCRATCH_SEGMENT)) {
      expect(`/tmp/kawai-codex-smoke-${match[1]}`).toBe(SMOKE_FIXTURE_WORKSPACE)
    }
  })
})
