import { describe, expect, test } from 'bun:test'
import type { Session } from '../../shared/types'
import { revalidateRematchTarget } from '../sessionWake/rematchTarget'

const candidate: Session = {
  id: 'agentboard:@1', tmuxWindow: 'agentboard:@1', name: 'old',
  projectPath: '/tmp', status: 'waiting', source: 'managed',
  createdAt: '2026-10-04T00:00:00.000Z', lastActivity: '2026-10-04T00:00:00.000Z',
}

describe('wake rematch target revalidation', () => {
  test('does not claim a window killed while matching was pending', async () => {
    expect(await revalidateRematchTarget(candidate, async () => null, () => candidate)).toBeNull()
  })
  test('uses current metadata rather than the captured candidate', async () => {
    const current = { ...candidate, name: 'renamed', command: 'updated-command', status: 'working' as const }
    expect(await revalidateRematchTarget(candidate, async () => '@1', () => current)).toBe(current)
  })
  test('discards a target removed from the registry during the probe', async () => {
    let current: Session | undefined = candidate
    const probe = async () => { current = undefined; return '@1' }
    expect(await revalidateRematchTarget(candidate, probe, () => current)).toBeNull()
  })
  test('does not hydrate a replaced target or remote session', async () => {
    for (const current of [{ ...candidate, tmuxWindow: 'agentboard:@2' }, { ...candidate, remote: true }]) {
      expect(await revalidateRematchTarget(candidate, async () => '@1', () => current)).toBeNull()
    }
  })
})
