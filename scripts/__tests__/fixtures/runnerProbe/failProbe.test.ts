import { expect, test } from 'bun:test'
import { recordRoots } from './recordRoots'

recordRoots('failProbe')

test('failProbe always fails', () => {
  expect(1).toBe(2)
})
