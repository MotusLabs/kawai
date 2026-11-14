// Real shell/pipe controls for the zombie fixture's setup and cleanup.
// The reaped control forces a permitted old ordering, not the historic CI schedule.
import { afterEach, expect, test } from 'bun:test'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { ownedAggregate } from './helpers/ownedCleanup.js'
import { processIdentity, ZombieFixture } from './helpers/zombieFixture.js'

const owned = ownedAggregate<ZombieFixture, void>({
  join: (fixture) => fixture.cleanup(),
  failures: (_fixture, outcome) => outcome.status === 'rejected' ? [outcome.reason] : [],
  message: 'zombie control cleanups failed',
})
afterEach(() => owned.join())

function create(mode: 'gated' | 'reaped' = 'gated'): ZombieFixture {
  const fixture = new ZombieFixture(mode)
  owned.add(fixture)
  return fixture
}

test('the shared validator rejects a child reaped before parent exec', async () => {
  const fixture = create('reaped')
  await fixture.setup() // parent wait has reaped the child; exec is observed
  expect(processIdentity(fixture.helper)).toBeNull()
  expect(() => fixture.validateReady()).toThrow('helper missing or nonlive before release')
  await fixture.cleanup()
  expect(fixture.didClose).toBe(true)
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('cleanup joins a gated stdout-holding helper after its leader exits', async () => {
  const fixture = create()
  await fixture.setup()
  const before = fixture.validateReady()
  expect(fixture.child.kill('SIGKILL')).toBe(true)
  await fixture.exited
  expect(fixture.didClose).toBe(false) // helper still owns stdout and fd3
  expect(processIdentity(fixture.helper)?.start).toBe(before.start)
  expect(liveGroupMembers(fixture.leader)).toEqual([fixture.helper])
  const cleanup = fixture.cleanup()
  expect(fixture.cleanup()).toBe(cleanup)
  await cleanup
  expect(fixture.didClose).toBe(true)
  await Promise.all([fixture.closed, fixture.exited, fixture.gateClosed, fixture.stdoutClosed])
  expect(liveGroupMembers(fixture.leader)).toEqual([])
  expect(['Z', 'X', undefined]).toContain(processIdentity(fixture.helper)?.state)
})
