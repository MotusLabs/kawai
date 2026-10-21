import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProcDead } from './fixtures/runnerProbe/procState'
import { buildBunTestArgs } from '../planBatches'
import {
  defaultWorkers,
  forwardSignalAndReap,
  isOwnerAlive,
  parseCpuQuota,
  parseRunArgs,
  readOwnerMarker,
  readProcStartTime,
  sweepStaleRoots,
  workersFromEnv,
  writeOwnerMarker,
} from '../test-runner'

describe('parseRunArgs', () => {
  test('splits flags, file arguments, and passthrough', () => {
    const parsed = parseRunArgs(['--skip-real-tmux', '--coverage', 'a.test.ts', 'deep/b.test.tsx'])
    expect(parsed.skipRealTmux).toBe(true)
    expect(parsed.fileArgs).toEqual(['a.test.ts', 'deep/b.test.tsx'])
    expect(parsed.passthrough).toEqual(['--coverage'])
  })
})

describe('workersFromEnv', () => {
  test('unset takes the given fallback, the measured default by another name', () => {
    expect(workersFromEnv({}, 4)).toBe(4)
    expect(workersFromEnv({ KAWAI_TEST_WORKERS: '' }, 4)).toBe(4)
    expect(workersFromEnv({}, 1)).toBe(1)
  })

  test('accepts a positive integer override and refuses the rest', () => {
    expect(workersFromEnv({ KAWAI_TEST_WORKERS: '2' }, 4)).toBe(2)
    expect(() => workersFromEnv({ KAWAI_TEST_WORKERS: '0' })).toThrow()
    expect(() => workersFromEnv({ KAWAI_TEST_WORKERS: 'x' })).toThrow()
    expect(() => workersFromEnv({ KAWAI_TEST_WORKERS: '1.5' })).toThrow()
  })
})

describe('parseCpuQuota', () => {
  test('divides the cgroup v2 quota by its period', () => {
    expect(parseCpuQuota('600000 100000')).toBe(6)
    expect(parseCpuQuota('300000 100000')).toBe(3)
    expect(parseCpuQuota('150000 100000')).toBe(1)
    expect(parseCpuQuota('600000 100000\n')).toBe(6)
  })

  test('unbounded, malformed, or non-integer quotas read as absent', () => {
    expect(parseCpuQuota('max 100000')).toBeNull()
    expect(parseCpuQuota('max')).toBeNull()
    expect(parseCpuQuota('')).toBeNull()
    expect(parseCpuQuota('six 100000')).toBeNull()
    expect(parseCpuQuota('600000.5 100000')).toBeNull()
    expect(parseCpuQuota('600000 0')).toBeNull()
  })
})

describe('defaultWorkers', () => {
  test('never above the measured count, capped by the CPU cap, never below 1', () => {
    expect(defaultWorkers(6)).toBe(4)
    expect(defaultWorkers(16)).toBe(4)
    expect(defaultWorkers(2)).toBe(2)
    expect(defaultWorkers(0)).toBe(1)
  })
})

describe('buildBunTestArgs', () => {
  test('passes --parallel=1 and a 20 s default timeout for one worker', () => {
    const args = buildBunTestArgs({ workers: 1, files: ['a.test.ts'], passthrough: [] })
    expect(args[0]).toBe('--parallel=1')
    expect(args[1]).toBe('--timeout=20000')
    expect(args[2]).toBe('--preload')
    expect(args[3]).toBe('scripts/test-preload.ts')
  })

  test('passes the worker count, the timeout, the preload, passthrough flags, then files', () => {
    const args = buildBunTestArgs({
      workers: 2,
      files: ['b.test.ts', 'a.test.ts'],
      passthrough: ['--coverage'],
    })
    expect(args[0]).toBe('--parallel=2')
    expect(args[1]).toBe('--timeout=20000')
    expect(args.slice(2, 4)).toEqual(['--preload', 'scripts/test-preload.ts'])
    expect(args).toContain('--coverage')
    // Relative files are './'-prefixed: Bun reads a bare relative path
    // outside the bunfig test root as a filter, not a path.
    expect(args.slice(-2)).toEqual(['./b.test.ts', './a.test.ts'])
  })
})

describe('run-root ownership', () => {
  function makeRootsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-owner-probe-'))
  }

  test('a marked root whose owner is alive with a matching start time survives the sweep', () => {
    const dir = makeRootsDir()
    const live = path.join(dir, 'agentboard-tests-live')
    fs.mkdirSync(live)
    writeOwnerMarker(live)
    const marker = readOwnerMarker(live)
    expect(marker).not.toBeNull()
    expect(isOwnerAlive(marker!.pid, marker!.starttime)).toBe(true)

    expect(sweepStaleRoots(dir)).toEqual([])
    expect(fs.existsSync(live)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a marked root whose owner is dead is removed', async () => {
    const dir = makeRootsDir()
    const deadChild = Bun.spawn([process.execPath, '-e', ''])
    const deadPid = deadChild.pid
    const starttime = readProcStartTime(deadPid)
    expect(await deadChild.exited).toBe(0)

    const root = path.join(dir, 'agentboard-tests-dead')
    fs.mkdirSync(root)
    writeOwnerMarker(root, { pid: deadPid, starttime })
    expect(isOwnerAlive(deadPid, starttime)).toBe(false)

    expect(sweepStaleRoots(dir)).toEqual([root])
    expect(fs.existsSync(root)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a live pid with a different start time (pid reuse) is removed', () => {
    const dir = makeRootsDir()
    const root = path.join(dir, 'agentboard-tests-reused')
    fs.mkdirSync(root)
    writeOwnerMarker(root, { pid: process.pid, starttime: '1' })
    expect(isOwnerAlive(process.pid, '1')).toBe(false)
    expect(sweepStaleRoots(dir)).toEqual([root])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('an unmarked root is kept while fresh and removed after 24 h', () => {
    const dir = makeRootsDir()
    const fresh = path.join(dir, 'agentboard-tests-fresh')
    const old = path.join(dir, 'agentboard-tests-old')
    fs.mkdirSync(fresh)
    fs.mkdirSync(old)
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(old, yesterday, yesterday)

    expect(sweepStaleRoots(dir)).toEqual([old])
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(old)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a malformed marker counts as unmarked: fresh is kept, old is removed', () => {
    const dir = makeRootsDir()
    const fresh = path.join(dir, 'agentboard-tests-broken-fresh')
    const old = path.join(dir, 'agentboard-tests-broken-old')
    fs.mkdirSync(fresh)
    fs.mkdirSync(old)
    fs.writeFileSync(path.join(fresh, 'owner.json'), '{not json')
    fs.writeFileSync(path.join(old, 'owner.json'), '{not json')
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(old, yesterday, yesterday)

    expect(sweepStaleRoots(dir)).toEqual([old])
    expect(fs.existsSync(fresh)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('directories without the run-root prefix are never touched', () => {
    const dir = makeRootsDir()
    const other = path.join(dir, 'other-stuff')
    fs.mkdirSync(other)
    expect(sweepStaleRoots(dir)).toEqual([])
    expect(fs.existsSync(other)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('forwardSignalAndReap', () => {
  test('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reap-probe-'))
    const ready = path.join(root, 'ready')
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'fixtures', 'runnerProbe', 'ignoreTerm.ts')],
      { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, READY_FILE: ready } }
    )
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20)
    expect(fs.existsSync(ready)).toBe(true)
    const started = Date.now()
    await forwardSignalAndReap(child, 'SIGTERM', root, 150)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await child.exited).toBe(137)
    expect(fs.existsSync(root)).toBe(false)
  }, 15_000)

  test('the escalation kills a grandchild of a child that ignores SIGTERM (T2)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reap-probe-'))
    const ready = path.join(root, 'ready')
    const gcPidFile = path.join(root, 'gc.pid')
    const heartbeat = path.join(root, 'hb.txt')
    // detached, like the runner spawns every bun test child: the child leads
    // its own process group, so the group kill reaches the grandchild.
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'fixtures', 'runnerProbe', 'ignoreTerm.ts')],
      {
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
        env: { ...process.env, READY_FILE: ready, GC_HEARTBEAT_FILE: heartbeat, GC_PID_FILE: gcPidFile },
      }
    )
    const deadline = Date.now() + 5_000
    while ((!fs.existsSync(ready) || !fs.existsSync(gcPidFile)) && Date.now() < deadline) await Bun.sleep(20)
    expect(fs.existsSync(gcPidFile), 'fixture never spawned its grandchild').toBe(true)
    const gcPid = Number(fs.readFileSync(gcPidFile, 'utf8'))
    await forwardSignalAndReap(child, 'SIGTERM', root, 150)
    expect(await child.exited).toBe(137)
    expect(isProcDead(gcPid)).toBe(true)
    expect(fs.existsSync(root)).toBe(false)
  }, 15_000)

  test('a child that dies on the signal needs no escalation', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1e6)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reap-probe-'))
    await forwardSignalAndReap(child, 'SIGTERM', root, 5_000)
    expect(await child.exited).toBe(143)
    expect(fs.existsSync(root)).toBe(false)
  }, 15_000)

  test('removes the run root even when there is no child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reap-probe-'))
    await forwardSignalAndReap(null, 'SIGTERM', root, 10)
    expect(fs.existsSync(root)).toBe(false)
  })
})

