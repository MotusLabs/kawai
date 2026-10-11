// Spawned sessions waiting on the human toast once, with no task view open.
import { expect, spyOn, test } from 'bun:test'
import type { Session } from '@shared/types'
import { toastManager } from '../components/Toast'
import { notifySpawnedAttention, spawnedNeedsAttention } from '../utils/teamTaskNotification'

const session = (extra: Partial<Session>): Session => ({
  id: 'chat-1', name: 'devs helper', projectPath: '/repo-feature', status: 'working', lastActivity: '', createdAt: '',
  source: 'managed', kind: 'chat', spawned: true, taskId: 'task-1', taskTitle: 'Export', ...extra,
} as Session)

test('only a spawned, non-archived session in permission status needs attention', () => {
  expect(spawnedNeedsAttention(session({ status: 'permission' }))).toBe(true)
  expect(spawnedNeedsAttention(session({ status: 'permission', spawned: false }))).toBe(false)
  expect(spawnedNeedsAttention(session({ status: 'permission', archivedAt: '2026-10-11' }))).toBe(false)
  expect(spawnedNeedsAttention(session({ status: 'waiting' }))).toBe(false)
})

test('the transition into permission toasts once; staying or resolving does not', () => {
  const add = spyOn(toastManager, 'add').mockImplementation(() => 'toast')
  try {
    notifySpawnedAttention(session({ status: 'working' }), session({ status: 'permission' }))
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0]![0]).toMatchObject({ title: 'Spawned session needs attention', description: expect.stringContaining('task: Export') })
    notifySpawnedAttention(session({ status: 'permission' }), session({ status: 'permission' }))
    notifySpawnedAttention(session({ status: 'permission' }), session({ status: 'working' }))
    notifySpawnedAttention(undefined, session({ status: 'permission' }))
    notifySpawnedAttention(session({ status: 'working', spawned: false }), session({ status: 'permission', spawned: false }))
    expect(add).toHaveBeenCalledTimes(1)
  } finally {
    add.mockRestore()
  }
})
