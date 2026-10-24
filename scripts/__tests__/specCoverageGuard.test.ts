// specCoverageGuard.test.ts — the repo-wide @covers guard (independent-
// verification tasks 5.2, D8): the real repository's annotations resolve
// against the main specs and the active changes' deltas, sit directly above
// test calls, name no separator, and cover every required scenario of a
// newly archived change. The grammar and the archive rule are tested over
// fixture trees in specCoverageFixtures.test.ts; this file is the one run
// over the real repository, so a false failure here blocks every push.
// @reads: openspec/**
import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { runSpecCoverageGuard } from '../lib/specCoverage'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

describe('the repo-wide @covers guard', () => {
  test('every annotation resolves, sits above a test, and archives are covered', () => {
    const { failures, filesScanned } = runSpecCoverageGuard(REPO_ROOT)
    expect(filesScanned).toBeGreaterThan(0)
    expect(
      failures.map((failure) => `${failure.kind}: ${failure.message}`),
    ).toEqual([])
  })
})
