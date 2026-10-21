import { expect, mock, test } from 'bun:test'
import { recordRoots } from './recordRoots'

// F2 fixture (file A): mocks a local module. Under the per-file runner the
// mock dies with this file's registry; under a shared-process batch it would
// poison file B.
recordRoots('mockLeakA')

mock.module('./leakTarget', () => ({ leakProbeValue: 'mocked' }))

test('mockLeakA sees its own mock', async () => {
  const mocked = await import('./leakTarget')
  expect(mocked.leakProbeValue).toBe('mocked')
})
