import { expect, test } from 'bun:test'
import { recordRoots } from './recordRoots'

recordRoots('rootsProbe')

test('rootsProbe passes', () => {
  expect(1).toBe(1)
})
