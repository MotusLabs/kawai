// Production-path probes (checkpoint 2): these drive the real
// scripts/test-runner.ts the way `bun run test` does and assert the
// per-file-root invariant from the spec — concurrent files and sequential
// files on one reused worker get distinct runner-provided roots, and every
// root is removed after the run, on success, failure, and SIGTERM.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
})

