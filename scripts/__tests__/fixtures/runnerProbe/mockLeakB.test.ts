import { expect, test } from 'bun:test'
import { recordRoots } from './recordRoots'
import { leakProbeValue } from './leakTarget'

// F2 fixture (file B): imports the module mockLeakA mocked and asserts the
// real export — the proof that a module mock does not leak between files.
recordRoots('mockLeakB')

test('mockLeakB observes the real export, not mockLeakA\'s mock', () => {
  expect(leakProbeValue).toBe('real')
})
