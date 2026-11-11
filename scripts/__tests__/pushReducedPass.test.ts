// pushReducedPass.test.ts - The pre-push hook accepts any recorded pass,
// whatever its retries and case profile (check-time-optimization D3, task
// 3.7): the record the hook looks up for a pushed tree (readTreeRecord)
// carries the fields through, and decidePush passes a ref whose tree it
// found.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRecord, type CaseProfile, type CheckRecord } from '../../src/server/checks/checkRecords'
import { decidePush } from '../lib/pushCheck'
import { readTreeRecord, treeRecordKey } from '../lib/treeRecord'

const TREE = 'c'.repeat(40)
const COMMIT = 'a'.repeat(40)
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-push-profile-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function recordPass(caseProfile: CaseProfile | undefined, retried: boolean): void {
  const record: CheckRecord = {
    key: treeRecordKey(TREE),
    treeId: TREE,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: '/somewhere',
    steps: [{ name: 'test', ms: 1 }],
    ...(caseProfile !== undefined ? { caseProfile } : {}),
    ...(retried ? { retries: [{ file: 'src/server/__tests__/integration.test.ts', failures: ['a test'] }] } : {}),
  }
  writeRecord(dir, record)
}

function pushVerdict() {
  const recorded = readTreeRecord(dir, TREE) !== null
  // HEAD elsewhere and a dirty tree: only the recorded pass can let it through.
  return decidePush(
    [{ kind: 'commit', ref: 'refs/heads/feature', commit: COMMIT, tree: TREE, recorded, head: null, dirtyPaths: ['x'] }],
    []
  ).kind
}

for (const [profile, retried] of [
  ['reduced', false],
  ['reduced', true],
  ['full', true],
  [undefined, false],
] as const) {
  // @covers: dev-checks › A recorded pass names its retries and case profile › Pushing a reduced pass
  test(`the pre-push hook accepts a ${profile ?? 'unknown'}-profile pass${retried ? ' with retries' : ''}`, () => {
    recordPass(profile, retried)
    expect(readTreeRecord(dir, TREE)?.caseProfile).toBe(profile)
    expect(pushVerdict()).toBe('pass')
  })
}
