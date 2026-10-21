// Production-path probes (checkpoint 2): these drive the real
// scripts/test-runner.ts the way `bun run test` does and assert the
// per-file-root invariant from the spec — concurrent files and sequential
// files on one reused worker get distinct runner-provided roots, and every
// root is removed after the run, on success, failure, and SIGTERM.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProcDead } from './fixtures/runnerProbe/procState'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const FIXTURE_DIR = path.join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'runnerProbe')
const ROOT_PREFIX = 'agentboard-tests-'

interface ProbeEntry {
  name: string
  pid: number
  db: string
  log: string
  claude: string
  codex: string
}

const probeDirs: string[] = []
afterAll(() => {
  for (const dir of probeDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function makeProbeOut(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-roots-probe-'))
  probeDirs.push(dir)
  return path.join(dir, 'roots.jsonl')
}

function spawnRunner(args: string[], extraEnv: Record<string, string>): Bun.Subprocess {
  return Bun.spawn({
    cmd: [process.execPath, RUNNER, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function drainAndExit(proc: Bun.Subprocess): Promise<{ code: number; stderr: string }> {
  const stderrText = new Response(proc.stderr).text()
  const stdoutText = new Response(proc.stdout).text()
  const code = await proc.exited
  const [, stderr] = await Promise.all([stdoutText, stderrText])
  return { code, stderr }
}

async function readProbeEntries(
  file: string,
  minEntries: number,
  timeoutMs: number
): Promise<ProbeEntry[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length >= minEntries) {
      return lines.map((line) => JSON.parse(line) as ProbeEntry)
    }
    if (Date.now() > deadline) {
      throw new Error(`probe output never reached ${minEntries} entries: ${text}`)
    }
    await Bun.sleep(100)
  }
}

const PASSING_PROBES = ['rootsProbe.test.ts', 'rootsProbe2.test.ts'].map((name) =>
  path.join(FIXTURE_DIR, name)
)

describe('the real runner gives each file its own root', () => {
  test('two files under workers=2 get distinct roots that are removed', async () => {
    const out = makeProbeOut()
    const proc = spawnRunner(['--skip-real-tmux', ...PASSING_PROBES], {
      KAWAI_TEST_WORKERS: '2',
      KAWAI_PROBE_OUT: out,
    })
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(0)
    const entries = await readProbeEntries(out, 2, 1_000)
    expect(entries).toHaveLength(2)
    const dbs = new Set(entries.map((entry) => entry.db))
    expect(dbs.size).toBe(2)
    for (const entry of entries) {
      expect(entry.db).not.toBe(process.env.AGENTBOARD_DB_PATH)
      expect(entry.db).toContain(ROOT_PREFIX)
      expect(fs.existsSync(entry.db)).toBe(false)
      expect(fs.existsSync(entry.claude)).toBe(false)
    }
  }, 30_000)

  test('a worker reused for the next file gets a fresh root', async () => {
    const out = makeProbeOut()
    const proc = spawnRunner(['--skip-real-tmux', ...PASSING_PROBES], {
      KAWAI_TEST_WORKERS: '1',
      KAWAI_PROBE_OUT: out,
    })
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(0)
    const entries = await readProbeEntries(out, 2, 1_000)
    expect(entries).toHaveLength(2)
    expect(entries[0].pid).toBe(entries[1].pid)
    expect(entries[0].db).not.toBe(entries[1].db)
    expect(fs.existsSync(entries[1].db)).toBe(false)
  }, 30_000)

  test('after a failing file the run fails and every root is removed', async () => {
    const out = makeProbeOut()
    const proc = spawnRunner(
      ['--skip-real-tmux', ...PASSING_PROBES.slice(0, 1), path.join(FIXTURE_DIR, 'failProbe.test.ts')],
      { KAWAI_TEST_WORKERS: '1', KAWAI_PROBE_OUT: out }
    )
    const { code } = await drainAndExit(proc)
    expect(code).not.toBe(0)
    const entries = await readProbeEntries(out, 2, 1_000)
    for (const entry of entries) {
      expect(fs.existsSync(entry.db)).toBe(false)
      expect(fs.existsSync(entry.claude)).toBe(false)
    }
  }, 30_000)

  test('SIGTERM removes the run root and exits 143', async () => {
    const out = makeProbeOut()
    const proc = spawnRunner(['--skip-real-tmux', path.join(FIXTURE_DIR, 'sleepProbe.test.ts')], {
      KAWAI_TEST_WORKERS: '1',
      KAWAI_PROBE_OUT: out,
    })
    const [entry] = await readProbeEntries(out, 1, 20_000)
    expect(fs.existsSync(entry.claude)).toBe(true)
    process.kill(proc.pid, 'SIGTERM')
    const { code } = await drainAndExit(proc)
    expect(code).toBe(143)
    expect(fs.existsSync(entry.claude)).toBe(false)
  }, 45_000)

  // T1 (decision D-g): the fixture's heartbeat grandchild stands in for the
  // tmux, git, or spawned-server processes real tests start. The runner must
  // forward the signal to the child's whole process group, so the grandchild
  // dies with it and the run root is removed. A zombie counts as dead.
  async function signalKillsWholeGroup(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-gc-probe-'))
    probeDirs.push(dir)
    const ready = path.join(dir, 'ready.json')
    const heartbeat = path.join(dir, 'hb.txt')
    const proc = spawnRunner(['--skip-real-tmux', path.join(FIXTURE_DIR, 'spawnGcProbe.test.ts')], {
      KAWAI_TEST_WORKERS: '1',
      GC_READY_FILE: ready,
      GC_HEARTBEAT_FILE: heartbeat,
    })
    const deadline = Date.now() + 20_000
    // The grandchild must have written its first heartbeat line before the
    // signal: the group kill may otherwise land before the writer starts.
    while ((!fs.existsSync(ready) || !fs.existsSync(heartbeat)) && Date.now() < deadline) {
      await Bun.sleep(50)
    }
    expect(fs.existsSync(ready), 'fixture never spawned its grandchild').toBe(true)
    expect(fs.existsSync(heartbeat), 'grandchild never wrote a heartbeat').toBe(true)
    const { pid: gcPid, runRoot } = JSON.parse(fs.readFileSync(ready, 'utf8')) as {
      pid: number
      runRoot: string
    }
    expect(runRoot, 'fixture saw no run root').toBeTruthy()
    process.kill(proc.pid, signal)
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(signal === 'SIGINT' ? 130 : 143)
    expect(fs.existsSync(runRoot)).toBe(false)
    const deadDeadline = Date.now() + 5_000
    while (!isProcDead(gcPid) && Date.now() < deadDeadline) await Bun.sleep(50)
    expect(isProcDead(gcPid)).toBe(true)
    // The heartbeat stopped: two samples taken after the runner exited (so
    // after the group kill) must agree.
    const count = () => fs.readFileSync(heartbeat, 'utf8').trim().split('\n').filter(Boolean).length
    const sample = count()
    expect(sample).toBeGreaterThan(0)
    await Bun.sleep(1_500)
    expect(count()).toBe(sample)
  }

  test('SIGTERM kills the whole child group: the grandchild dies and the heartbeat stops', async () => {
    await signalKillsWholeGroup('SIGTERM')
  }, 60_000)

  test('SIGINT kills the whole child group: the grandchild dies and the heartbeat stops', async () => {
    await signalKillsWholeGroup('SIGINT')
  }, 60_000)

  // T3 (decision D-g): a passing file may leave processes behind; the runner
  // kills them before it removes the run root.
  test('a leftover sleeper from a passing file is dead after the runner exits 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-leak-probe-'))
    probeDirs.push(dir)
    const pidFile = path.join(dir, 'sleeper.pid')
    const proc = spawnRunner(['--skip-real-tmux', path.join(FIXTURE_DIR, 'leakSleeper.test.ts')], {
      KAWAI_TEST_WORKERS: '1',
      SLEEPER_PID_FILE: pidFile,
    })
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(0)
    expect(stderr).toContain('[test-runner] killed leftover processes of batch:')
    const sleeperPid = Number(fs.readFileSync(pidFile, 'utf8'))
    const deadline = Date.now() + 5_000
    while (!isProcDead(sleeperPid) && Date.now() < deadline) await Bun.sleep(50)
    expect(isProcDead(sleeperPid)).toBe(true)
  }, 45_000)

  // F2 (review, spec Req 1): a module mock does not leak between files.
  // mockLeakA mocks a local module; mockLeakB must observe the real export.
  // Same worker pid proves both files ran in this run's worker.
  test('a module mock does not leak into the next file on the same worker', async () => {
    const out = makeProbeOut()
    const proc = spawnRunner(
      [
        '--skip-real-tmux',
        path.join(FIXTURE_DIR, 'mockLeakA.test.ts'),
        path.join(FIXTURE_DIR, 'mockLeakB.test.ts'),
      ],
      { KAWAI_TEST_WORKERS: '1', KAWAI_PROBE_OUT: out }
    )
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(0)
    const entries = await readProbeEntries(out, 2, 1_000)
    expect(entries.map((entry) => entry.name)).toEqual(['mockLeakA', 'mockLeakB'])
    expect(entries[0].pid).toBe(entries[1].pid)
  }, 30_000)

  // F5 (review): a signal handled while the main batch runs must stop the
  // batch loop — spawning the next batch would orphan it when the handler's
  // process.exit lands. This is not a race the guard barely wins: the
  // handler sets the flag synchronously when the signal arrives, and the
  // main batch ends only in response to the forwarded signal, so the loop's
  // continuation always finds the flag already set — the ordering stops the
  // serial batch on its own, and the refusal in runCommand (exported as
  // refuseBatchAfterSignal, unit-tested in testRunner.test.ts) is defense in
  // depth on that ordering. The serial fixture's basename classifies it as a
  // real-tmux batch, but it runs no tmux: it only marks that it started.
  test('a handled signal stops the batch loop: the serial batch never starts', async () => {
    const out = makeProbeOut()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-signal-race-'))
    probeDirs.push(dir)
    const pidFile = path.join(dir, 'serial-batch.pid')
    const proc = spawnRunner(
      [
        path.join(FIXTURE_DIR, 'signalRaceProbe.test.ts'),
        path.join(FIXTURE_DIR, 'integration.test.ts'),
      ],
      { KAWAI_TEST_WORKERS: '1', KAWAI_PROBE_OUT: out, SERIAL_BATCH_PID_FILE: pidFile }
    )
    await readProbeEntries(out, 1, 20_000)
    process.kill(proc.pid, 'SIGTERM')
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).toBe(143)
    const deadline = Date.now() + 4_000
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(50)
    expect(fs.existsSync(pidFile), 'the serial batch started after a handled signal').toBe(
      false
    )
  }, 45_000)

  // F1 (checkpoint-2 decision Q2): a bad KAWAI_TEST_WORKERS is refused
  // before the run root exists. The runner gets its own TMPDIR so the
  // assertion is about this run only — a concurrent runner's roots in the
  // shared tmpdir must not matter (review F4).
  test('a bad KAWAI_TEST_WORKERS exits non-zero and leaves no run root', async () => {
    const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tmp-probe-'))
    probeDirs.push(privateTmp)
    const proc = spawnRunner(['--skip-real-tmux', ...PASSING_PROBES], {
      KAWAI_TEST_WORKERS: 'x',
      TMPDIR: privateTmp,
    })
    const { code, stderr } = await drainAndExit(proc)
    expect(code, stderr.slice(-2000)).not.toBe(0)
    expect(stderr).toContain('KAWAI_TEST_WORKERS')
    expect(fs.readdirSync(privateTmp)).toEqual([])
  }, 30_000)
})

