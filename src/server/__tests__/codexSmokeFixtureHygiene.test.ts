// Fixture hygiene for the Codex smoke transcript (task rev 3). The recording
// script scrubs at write time (scripts/codex-smoke.ts, scrubSmokeValue); this
// test re-checks the committed fixture against the same rules independently,
// so no identifying value can reach a commit.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  SMOKE_FIXTURE_HOME,
  SMOKE_FIXTURE_WORKSPACE,
  SMOKE_SCRUB_STRINGS,
} from '../../../scripts/codex-smoke'

const FIXTURE_DIR = path.resolve(import.meta.dir, '..', 'chat', 'codex', '__fixtures__')
const HOME_SEGMENT = /\/home\/([0-9A-Za-z._-]+)/g
const SCRATCH_SEGMENT = /\/tmp\/kawai-codex-smoke-([0-9A-Za-z._-]+)/g

const violations: string[] = []

function check(where: string, key: string, value: unknown): void {
  if (typeof value === 'string') {
    // Any string under an identifying key must be its fixed placeholder.
    if (key && value !== SMOKE_SCRUB_STRINGS[key]) {
      violations.push(`${where}: ${key} holds a non-placeholder value`)
    }
    for (const match of value.matchAll(HOME_SEGMENT)) {
      if (`/home/${match[1]}` !== SMOKE_FIXTURE_HOME) violations.push(`${where}: home path ${match[0]}`)
    }
    for (const match of value.matchAll(SCRATCH_SEGMENT)) {
      if (`/tmp/kawai-codex-smoke-${match[1]}` !== SMOKE_FIXTURE_WORKSPACE) {
        violations.push(`${where}: scratch workspace ${match[0]}`)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => check(`${where}[${index}]`, key, entry))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [entryKey, entry] of Object.entries(value)) {
      check(`${where}.${entryKey}`, entryKey in SMOKE_SCRUB_STRINGS ? entryKey : key, entry)
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
      check(`record ${index}`, '', message)
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
