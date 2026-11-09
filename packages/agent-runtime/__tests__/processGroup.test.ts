// @reads: packages/agent-runtime/__tests__/fixtures/**
// Owned POSIX group termination (task 2.3, L11-L16/P16/I1): the leader exits
// first while a helper in its group keeps the inherited stdout pipe open and
// keeps writing. The leader's actual exit is retained apart from the pipe
// drain, and the stop receipt is issued only once the helper is dead and its
// writes have stopped. Control: removing the group cleanup after leader exit
// fails the helper-liveness and no-post-stop-write assertions.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLaunch } from '../src/process/launch.js'
import { spawnOwned, type OwnedProcess } from '../src/process/ownedProcess.js'

const FIXTURES = join(import.meta.dir, 'fixtures')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-group-')))
const helpers: number[] = []

afterAll(() => {
  for (const pid of helpers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(10)
  }
}

/** Spawn the leader, read the helper's pid, and wait until the leader has exited and the helper is writing. */
async function leaderGone(mode?: 'ignore-term'): Promise<{ owned: OwnedProcess; helper: number; ticks: string; drained: () => boolean }> {
  const ticks = join(root, `ticks-${helpers.length}`)
  const owned = spawnOwned({
    command: process.execPath,
    args: [join(FIXTURES, 'leaderWithHelper.ts'), ticks, ...(mode ? [mode] : [])],
    launch: resolveLaunch({ cwd: root, childEnv: {}, homeDir: root, cacheDir: root, tempDir: root }),
    generation: 1,
  })
  let drainedFlag = false
  let buffer = ''
  const helper = await new Promise<number>((resolve) => {
    owned.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /\{"helper":(\d+)\}/.exec(buffer)
      if (match) resolve(Number(match[1]))
    })
  })
  owned.stdout.on('end', () => {
    drainedFlag = true
  })
  helpers.push(helper)
  await owned.leaderExit
  await until(() => existsSync(ticks) && statSync(ticks).size > 3)
  return { owned, helper, ticks, drained: () => drainedFlag }
}

describe('owned process group after the leader exits', () => {
  test('leader exit is retained while the helper still holds the pipe; the receipt waits for the helper', async () => {
    const { owned, helper, ticks, drained } = await leaderGone()
    expect(owned.exited).toEqual({ kind: 'exited', code: 0, signal: null })
    expect(alive(helper)).toBe(true)
    expect(drained()).toBe(false) // actual exit is not the drain

    const fact = await owned.terminate({ graceMs: 1000, killMs: 2000 })
    expect(fact).toMatchObject({ state: 'exited', code: 0, signal: null, escalated: false, groupCleared: true })
    expect(alive(helper)).toBe(false)
    const size = statSync(ticks).size
    await Bun.sleep(150)
    expect(statSync(ticks).size).toBe(size) // no write after the receipt
  })

  test('a helper ignoring SIGTERM is escalated to SIGKILL before the receipt', async () => {
    const { owned, helper, ticks } = await leaderGone('ignore-term')
    const fact = await owned.terminate({ graceMs: 200, killMs: 2000 })
    expect(fact).toMatchObject({ state: 'exited', code: 0, escalated: true, groupCleared: true })
    expect(alive(helper)).toBe(false)
    const size = statSync(ticks).size
    await Bun.sleep(150)
    expect(statSync(ticks).size).toBe(size)
  })
})
