// Zombie liveness (batch B U2, task 4.2 I1 diagnosis): the historical Codex
// I1 failure in slice 75-89 (result-adcca8f2, "liveAtStop one pid") is the
// class this test pins. A process that exited but is not yet reaped still
// answers signal 0, so a liveness check built on kill(pid, 0) alone counts
// it as live. The container's PID 1 does not reap promptly, so a /child
// helper that outlives its app-server leader stays a zombie there. The
// production group check (processGroup.liveGroupMembers) and the Codex
// harness alive() both read /proc and count a zombie as dead.
//
// The zombie is deterministic: `sh -c '(exec true) & echo $!; exec sleep 30'`
// forks a child that exits at once, then replaces the shell with sleep,
// which never reaps it. The group leader (sleep) stays alive and is the
// group's one live member.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { alive } from './helpers/codexDriverHarness.js'
import { ownedAggregate, ownedOnce, type OwnedOnce } from './helpers/ownedCleanup.js'

interface Held { child: ChildProcess; exited: Promise<void>; closed: OwnedOnce<void> }

const owned = ownedAggregate<Held, void>({
  join: (held) =>
    held.closed.run(async () => {
      if (held.child.exitCode === null && held.child.signalCode === null) held.child.kill('SIGKILL')
      await held.exited
    }),
  failures: (_held, outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []),
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
  const child = spawn('/bin/sh', ['-c', '(exec true) & echo $!; exec sleep 30'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  // Joined by cleanup: the actual exit and the end of the child's stdout ('close' follows both).
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  owned.add({ child, exited, closed: ownedOnce<void>() })
  const line = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.includes('\n')) resolve(out.trim())
    })
    child.once('exit', () => reject(new Error('the zombie fixture exited early')))
  })
  const zombie = Number(line)
  const deadline = Date.now() + 5_000
  while (state(zombie) !== 'Z') {
    if (Date.now() > deadline) throw new Error(`pid ${zombie} never became a zombie (state ${state(zombie)})`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return { leader: child.pid!, zombie }
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
})
