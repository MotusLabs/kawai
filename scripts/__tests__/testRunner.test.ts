import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProcDead } from './fixtures/runnerProbe/procState'
import { buildBunTestArgs, planBatches, type PlannedBatch } from '../planBatches'
import { hasTestNameFilter, planRun, runBatchesAndPublish } from '../runPlan'
import {
  collectFiles,
  defaultWorkers,
  effectiveQuota,
  forwardSignalAndReap,
  isOwnerAlive,
  parseCpuQuota,
  parseRunArgs,
  readCpuQuota,
  readOwnerMarker,
  readProcStartTime,
  refuseBatchAfterSignal,
  sweepStaleRoots,
  workersFromEnv,
  writeOwnerMarker,
} from '../test-runner'

describe('refuseBatchAfterSignal', () => {
  test('a handled signal refuses the batch with its name; otherwise it passes (N1)', () => {
    expect(() => refuseBatchAfterSignal(false, 'main batch')).not.toThrow()
    expect(() => refuseBatchAfterSignal(true, 'real-tmux: integration.test.ts')).toThrow(
      'Signal handled; not starting batch: real-tmux: integration.test.ts'
    )
  })
})

describe('parseRunArgs', () => {
  test('splits flags, file arguments, and passthrough', () => {
    const parsed = parseRunArgs(['--skip-real-tmux', '--coverage', 'a.test.ts', 'deep/b.test.tsx'])
    expect(parsed.skipRealTmux).toBe(true)
    expect(parsed.fileArgs).toEqual(['a.test.ts', 'deep/b.test.tsx'])
    expect(parsed.passthrough).toEqual(['--coverage'])
  })

  test('recognizes --skip-slow (4.3, D7)', () => {
    expect(parseRunArgs(['--skip-slow']).skipSlowTier).toBe(true)
    expect(parseRunArgs([]).skipSlowTier).toBe(false)
  })
})

describe('hasTestNameFilter', () => {
  test('detects every -t and --test-name-pattern spelling the parser accepts', () => {
    expect(hasTestNameFilter([])).toBe(false)
    expect(hasTestNameFilter(['--coverage', '--rerun-each=2'])).toBe(false)
    expect(hasTestNameFilter(['-t'])).toBe(true)
    expect(hasTestNameFilter(['-t=refresh'])).toBe(true)
    expect(hasTestNameFilter(['--test-name-pattern'])).toBe(true)
    expect(hasTestNameFilter(['--test-name-pattern=refresh'])).toBe(true)
  })
})

describe('planRun', () => {
  const collected = {
    serverTests: ['src/server/__tests__/a.test.ts'],
    clientTests: ['src/client/__tests__/c.test.tsx'],
    runnerTests: ['scripts/__tests__/r.test.ts'],
    sharedTests: ['src/shared/__tests__/s.test.ts'],
  }
  const base = {
    workers: 4,
    collected,
    serialFiles: ['src/server/__tests__/integration.test.ts'],
    mainLabel: 'main batch',
    seedText: '{"version":1,"files":{}}',
  }

  test('--skip-slow plans the batches without the slow tier (B1)', () => {
    const plan = planRun({ ...base, args: parseRunArgs(['--skip-slow']), seedTimings: () => null })
    expect(plan.batchOptions.skipSlowTier).toBe(true)
    expect(plan.fullRun).toBe(true)
    // The composed options are what planBatches sees: no tmux batch, and no
    // slow-tier file among the scheduled arguments.
    const batches = planBatches(plan.batchOptions)
    expect(batches.some((batch) => batch.kind === 'real-tmux')).toBe(false)
    const scheduled = batches.flatMap((batch) => batch.cmd)
    expect(scheduled.join(' ')).not.toContain('integration.test.ts')
  })

  test('plain args keep both tiers and publish a full passing run (B1)', () => {
    let seededWith: string | null | undefined
    const plan = planRun({
      ...base,
      args: parseRunArgs([]),
      seedTimings: (seed) => {
        seededWith = seed
        return '/run-root/timings.json'
      },
    })
    expect(plan.batchOptions.skipSlowTier).toBe(false)
    expect(planBatches(plan.batchOptions).some((batch) => batch.kind === 'real-tmux')).toBe(true)
    expect(plan.fullRun).toBe(true)
    expect(plan.publishTimings).toBe(true)
    expect(plan.batchOptions.timingsPath).toBe('/run-root/timings.json')
    expect(plan.batchOptions.updateTimings).toBe(true)
    expect(seededWith).toBe(base.seedText)
  })

  test('a full run whose seed failed plans no publish (F5)', () => {
    const plan = planRun({ ...base, args: parseRunArgs([]), seedTimings: () => null })
    expect(plan.fullRun).toBe(true)
    expect(plan.publishTimings).toBe(false)
    // The batch options carry the same decision: nothing seeded, nothing to
    // update, so the main batch runs without --update-timings and main()
    // wires no publish path into runBatchesAndPublish.
    expect(plan.batchOptions.timingsPath).toBeUndefined()
    expect(plan.batchOptions.updateTimings).toBe(false)
  })

  test('a -t filter or explicit files never publish and never seed (B1)', () => {
    let seedCalls = 0
    const seedTimings = () => {
      seedCalls += 1
      return '/run-root/timings.json'
    }
    for (const argv of [
      ['-t', 'refresh'],
      ['-t=refresh'],
      ['--test-name-pattern=refresh'],
      ['src/server/__tests__/a.test.ts'],
    ]) {
      const plan = planRun({ ...base, args: parseRunArgs(argv), seedTimings })
      expect(plan.fullRun).toBe(false)
      expect(plan.publishTimings).toBe(false)
      expect(plan.batchOptions.timingsPath).toBeUndefined()
      expect(plan.batchOptions.updateTimings).toBe(false)
    }
    expect(seedCalls).toBe(0)
  })

  test('the main batch is the collected files in order, spelled as files (follow-up)', () => {
    const plan = planRun({ ...base, args: parseRunArgs([]), seedTimings: () => null })
    expect(plan.batchOptions.mainFiles).toEqual([
      'src/server/__tests__/a.test.ts',
      'scripts/__tests__/r.test.ts',
      'src/shared/__tests__/s.test.ts',
      'src/client/__tests__/c.test.tsx',
    ])
    // A slow-tier file under src/shared/__tests__ is excluded like any other:
    // the directory itself is never an entry the per-file filter would miss.
    const withSharedTier = planRun({
      ...base,
      args: parseRunArgs(['--skip-slow']),
      collected: {
        ...collected,
        sharedTests: ['src/shared/__tests__/chatTime.integration.test.ts', 'src/shared/__tests__/chatTime.test.ts'],
      },
      seedTimings: () => null,
    })
    const scheduled = planBatches(withSharedTier.batchOptions).flatMap((batch) => batch.cmd)
    expect(scheduled).not.toContain('./src/shared/__tests__/chatTime.integration.test.ts')
    expect(scheduled).toContain('./src/shared/__tests__/chatTime.test.ts')
  })

  test('collectFiles enumerates every source tree as files (follow-up)', async () => {
    const files = await collectFiles()
    const all = [...files.serverTests, ...files.clientTests, ...files.runnerTests, ...files.sharedTests]
    expect(all.length).toBeGreaterThan(100)
    for (const file of all) {
      expect(file.endsWith('.test.ts') || file.endsWith('.test.tsx')).toBe(true)
    }
    expect(files.sharedTests).toContain('src/shared/__tests__/chatTime.test.ts')
  })
})

describe('runBatchesAndPublish', () => {
  const env = { KAWAI_TEST_RUN_ROOT: '/run-root' }
  const batch = (label: string): PlannedBatch => ({
    kind: 'parallel',
    label,
    cmd: ['bun', 'test', `./${label}.test.ts`],
  })

  test('a failed batch never publishes and no later batch starts (B3)', async () => {
    const calls: Array<{ cmd: string[]; env: NodeJS.ProcessEnv; label: string }> = []
    const publishedPaths: string[] = []
    let thrown: unknown
    try {
      await runBatchesAndPublish({
        batches: [batch('main batch'), batch('real-tmux: late.test.ts')],
        env,
        publishTimingsPath: '/run-root/timings.json',
        publish: (timingsPath) => {
          publishedPaths.push(timingsPath)
        },
        runCommand: async (cmd, receivedEnv, batchLabel) => {
          calls.push({ cmd, env: receivedEnv, label: batchLabel })
          if (batchLabel === 'main batch') throw new Error('Command failed (1): bun test')
        },
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toBe('Command failed (1): bun test')
    // The double receives exactly what main() passes the real runCommand,
    // and the throw leaves the serial batch unstarted.
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toEqual(batch('main batch').cmd)
    expect(calls[0].env).toBe(env)
    expect(publishedPaths).toEqual([])
  })

  test('a passing run publishes exactly once, after the first batch, when the plan may publish (B3)', async () => {
    const order: string[] = []
    let publishedPath: string | undefined
    await runBatchesAndPublish({
      batches: [batch('main batch'), batch('real-tmux: late.test.ts')],
      env,
      publishTimingsPath: '/run-root/timings.json',
      publish: (timingsPath) => {
        order.push('publish')
        publishedPath = timingsPath
      },
      runCommand: async (_cmd, _env, batchLabel) => {
        order.push(`run:${batchLabel}`)
      },
    })
    // The record lands between the main batch and the serial one — a later
    // serial batch failing must not lose it — and the once-guard keeps the
    // passing serial batch from publishing again.
    expect(order).toEqual(['run:main batch', 'publish', 'run:real-tmux: late.test.ts'])
    // The step publishes exactly the path the plan seeded.
    expect(publishedPath).toBe('/run-root/timings.json')
  })

  test('a passing run whose plan may not publish never calls the publish step (B3)', async () => {
    const publishedPaths: string[] = []
    let ran = 0
    await runBatchesAndPublish({
      batches: [batch('main batch')],
      env,
      publishTimingsPath: null,
      publish: (timingsPath) => {
        publishedPaths.push(timingsPath)
      },
      runCommand: async () => {
        ran += 1
      },
    })
    expect(ran).toBe(1)
    expect(publishedPaths).toEqual([])
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

describe('effectiveQuota', () => {
  test('prefers the cgroup cpu.max over the platform parallelism (F7)', () => {
    expect(effectiveQuota(() => 2)).toBe(2)
    expect(effectiveQuota(() => 9)).toBe(9)
  })

  test('falls back to the platform parallelism when cpu.max is absent', () => {
    expect(effectiveQuota(() => null)).toBe(os.availableParallelism())
  })

  test('the default reader is the production cgroup read (F6)', () => {
    // The default parameter binds the production reader: a stubbed default
    // would report a constant quota whatever host the runner starts on.
    expect(effectiveQuota()).toBe(readCpuQuota() ?? os.availableParallelism())
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

  test('carries the timings record before the passthrough and file arguments (3.1)', () => {
    const args = buildBunTestArgs({
      workers: 4,
      files: ['a.test.ts'],
      passthrough: ['--coverage'],
      timingsPath: '/run/root/timings.json',
      updateTimings: true,
    })
    const timings = args.indexOf('--timings=/run/root/timings.json')
    expect(timings).toBeGreaterThan(-1)
    expect(args[timings + 1]).toBe('--update-timings')
    expect(args.indexOf('--coverage')).toBeGreaterThan(timings + 1)
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
    // Bounded poll, like runnerRoots: the SIGKILL may take a moment to
    // retire the grandchild, and a zombie counts as dead (review F6).
    const deadDeadline = Date.now() + 5_000
    while (!isProcDead(gcPid) && Date.now() < deadDeadline) await Bun.sleep(50)
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

