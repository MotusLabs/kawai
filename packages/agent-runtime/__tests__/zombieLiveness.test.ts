// Zombie liveness (batch B U2, task 4.2 I1 diagnosis): the historical Codex
// I1 failure in slice 75-89 (result-adcca8f2, "liveAtStop one pid") is the
// class this test pins. A process that exited but is not yet reaped still
// answers signal 0, so a liveness check built on kill(pid, 0) alone counts
// it as live. The container's PID 1 does not reap promptly, so a /child
// helper that outlives its app-server leader stays a zombie there. The
// production group check (processGroup.liveGroupMembers) and the Codex
// harness alive() both read /proc and count a zombie as dead.
//
// A dead process being reaped shows state X briefly; production counts it
// dead too, so alive() classifies a stat line through statShowsLive(), which
// counts Z and X dead (task-3c3e3658 R6 A18). The literal-stat table below
// pins that without catching a transient real X.
//
// A private fd gate holds the child until the same parent has exec'd
// sleep; only then may it exit. Cleanup owns exit, stdout and the extra fd.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { alive, statShowsLive } from './helpers/codexDriverHarness.js'
import { ownedAggregate } from './helpers/ownedCleanup.js'
import { ZombieFixture } from './helpers/zombieFixture.js'

const owned = ownedAggregate<ZombieFixture, void>({
  join: (fixture) => fixture.cleanup(),
  failures: (_fixture, outcome) => outcome.status === 'rejected' ? [outcome.reason] : [],
  message: 'zombie fixture cleanups failed',
})
afterEach(() => owned.join())

const state = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? null
  } catch {
    return null
  }
}

/** Signal 0 alone: the pre-fix harness check. */
const answersSignalZero = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function zombieGroup(): Promise<{ leader: number; zombie: number }> {
  const fixture = new ZombieFixture()
  owned.add(fixture)
  await fixture.setup()
  return fixture.zombie()
}

describe('zombie liveness (I1 diagnosis)', () => {
  test('an unreaped exited process answers signal 0, yet alive() and the production group check count it dead', async () => {
    const { leader, zombie } = await zombieGroup()
    expect(state(zombie)).toBe('Z')
    // The class the historical failure shows: signal 0 alone says the zombie lives.
    expect(answersSignalZero(zombie)).toBe(true)
    // The harness and production classify it as dead; the live leader stays live.
    expect(alive(zombie)).toBe(false)
    expect(alive(leader)).toBe(true)
    expect(liveGroupMembers(leader)).toEqual([leader])
  })

  test('a literal stat line in state X or Z is dead and one in state S or R is live, as production classifies them', () => {
    const line = (state: string) => `4242 (bun) ${state} 1 4240 4240 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 738427 0 0 18446744073709551615`
    const states = ['X', 'Z', 'S', 'R']
    // The pre-R6 classifier: only a zombie counted dead, so a reaping (X) process read as live.
    const oldShowsLive = (stat: string) => !/\) Z /.test(stat)
    expect(states.map((s) => [s, statShowsLive(line(s))])).toEqual([['X', false], ['Z', false], ['S', true], ['R', true]])
    expect(states.map((s) => [s, oldShowsLive(line(s))])).toEqual([['X', true], ['Z', false], ['S', true], ['R', true]])
  })
})
