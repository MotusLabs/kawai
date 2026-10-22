// readsGuard.test.ts — the repo-wide guard (per-result-suite task 1.2):
// every unit test file must declare the watched repository paths it reads at
// runtime in an `@reads` header. A failure names the file and the undeclared
// path; declare the read in that file's header (scripts/lib/reads.ts, D3)
// rather than loosening this assertion.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { listUnitTestFiles, scanTestSources } from '../lib/reads'

describe('the repo-wide @reads guard', () => {
  test('every unit test file declares the watched paths it reads', () => {
    const entries = listUnitTestFiles().map((file) => ({
      file,
      content: fs.readFileSync(file, 'utf8'),
    }))
    expect(scanTestSources(entries)).toEqual([])
  })
})
