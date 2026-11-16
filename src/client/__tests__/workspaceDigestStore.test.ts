import { afterEach, expect, test } from 'bun:test'
import { useWorkspaceStore } from '../stores/workspaceStore'
const initial = useWorkspaceStore.getState()
afterEach(() => useWorkspaceStore.setState(initial, true))
test('snapshot and received digest are replaced together and malformed snapshots retain both', () => {
  const snapshot = { repositories: [], generatedAt: '2026-01-01T00:00:00Z' }
  const observed: Array<[unknown, string | null]> = []
  const unsub = useWorkspaceStore.subscribe(state => observed.push([state.snapshot, state.digest]))
  expect(useWorkspaceStore.getState().applySnapshot(snapshot, '0123456789abcdef')).toBe(true)
  expect(observed).toHaveLength(1)
  expect(observed[0]).toEqual([snapshot, '0123456789abcdef'])
  expect(useWorkspaceStore.getState().applySnapshot({ broken: true }, '1111111111111111')).toBe(false)
  expect(useWorkspaceStore.getState().digest).toBe('0123456789abcdef')
  useWorkspaceStore.getState().clearSnapshot()
  expect(observed.at(-1)).toEqual([null, null])
  unsub()
})
