import { expect, test } from 'bun:test'
import { recordRoots } from './recordRoots'

recordRoots('rootsProbe2')

test('rootsProbe2 passes', () => {
  expect(2).toBe(2)
})
