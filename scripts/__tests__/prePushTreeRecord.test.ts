// prePushTreeRecord.test.ts — the tree-record lookup by Bun version
// (pre-push-bun-pin D2, contract A3, I1, I2, V2). Records are written with
// checkRecords' own writer under the key a check of that Bun computes; the
// lookup finds one only for the version it is given, on this platform and
// architecture, for the exact tree, unexpired. The default lookup (no
// version: the commit hook's amend gate) keys for the running Bun as before.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contentKeyFrom } from '../../src/server/checks/checkKey'
import { RECORD_TTL_MS, writeRecord, type CheckRecord } from '../../src/server/checks/checkRecords'
import { readTreeRecord, treeRecordKey } from '../lib/treeRecord'

const TREE = 'c'.repeat(40)
const OTHER_TREE = 'e'.repeat(40)
const RUNNING = Bun.version
const PIN = RUNNING === '1.0.0' ? '1.0.1' : '1.0.0'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-tree-record-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function record(bun: string, overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    key: treeRecordKey(TREE, bun),
    treeId: TREE,
    bun,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: '/somewhere',
    steps: [{ name: 'test', ms: 1 }],
    ...overrides,
  }
}

describe('treeRecordKey', () => {
  test('keys the given Bun on this platform and arch; the default is the running Bun', () => {
    const inputs = { treeId: TREE, platform: process.platform, arch: process.arch }
    expect(treeRecordKey(TREE)).toBe(contentKeyFrom({ ...inputs, bunVersion: RUNNING }))
    expect(treeRecordKey(TREE, PIN)).toBe(contentKeyFrom({ ...inputs, bunVersion: PIN }))
    expect(treeRecordKey(TREE, PIN)).not.toBe(treeRecordKey(TREE))
  })
})

describe('readTreeRecord by version', () => {
  test("a record under the pin's key is found only when looked up with the pin", () => {
    writeRecord(dir, record(PIN))
    expect(readTreeRecord(dir, TREE, Date.now(), PIN)?.bun).toBe(PIN)
    expect(readTreeRecord(dir, TREE)).toBeNull()
    expect(readTreeRecord(dir, TREE, Date.now(), RUNNING)).toBeNull()
  })

  test('the default lookup finds the running Bun record, as before', () => {
    writeRecord(dir, record(RUNNING))
    expect(readTreeRecord(dir, TREE)?.bun).toBe(RUNNING)
    expect(readTreeRecord(dir, TREE, Date.now(), PIN)).toBeNull()
  })

  test.each([
    ['another bun in the fields', { bun: '0.0.1' }],
    ['another platform', { platform: 'plan9' }],
    ['another arch', { arch: 'vax' }],
    ['another treeId', { treeId: OTHER_TREE }],
    ['an expired record', { at: new Date(Date.now() - RECORD_TTL_MS - 1000).toISOString() }],
  ])('a pin record with %s reads as null', (_name, overrides) => {
    writeRecord(dir, record(PIN, overrides))
    expect(readTreeRecord(dir, TREE, Date.now(), PIN)).toBeNull()
  })

  test.each([
    ['another bun in the fields', { bun: '0.0.1' }],
    ['another platform', { platform: 'plan9' }],
    ['another arch', { arch: 'vax' }],
    ['another treeId', { treeId: OTHER_TREE }],
    ['an expired record', { at: new Date(Date.now() - RECORD_TTL_MS - 1000).toISOString() }],
  ])('a default-lookup record with %s reads as null', (_name, overrides) => {
    writeRecord(dir, record(RUNNING, overrides))
    expect(readTreeRecord(dir, TREE)).toBeNull()
  })

  test("a malformed file under the pin's key reads as null", () => {
    fs.writeFileSync(path.join(dir, `${treeRecordKey(TREE, PIN)}.json`), '{ not json')
    expect(readTreeRecord(dir, TREE, Date.now(), PIN)).toBeNull()
  })
})
