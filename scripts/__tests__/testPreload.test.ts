// testPreload.test.ts — the per-file preload's contract, exercised through a
// real `bun test --preload scripts/test-preload.ts` child like the runner
// spawns: under a run root every variable, HOME included, points into one
// fresh per-file directory, and a bare `bun test` keeps the caller's
// environment unchanged (no run root, no rewrite).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The repository root, where the runner's children run and where the
// preload argument resolves.
const REPO_ROOT = path.join(import.meta.dir, '..')
const PRELOAD = path.join(REPO_ROOT, 'test-preload.ts')
const PROBE = path.join(import.meta.dir, 'fixtures', 'preloadProbe', 'envProbe.test.ts')

interface ProbeSnapshot {
  home: string | undefined
  claudeConfigDir: string | undefined
  codexHome: string | undefined
  logFile: string | undefined
  dbPath: string | undefined
  runRoot: string | null
}

async function runProbeChild(runRoot: string | null): Promise<ProbeSnapshot> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-probe-out-'))
  try {
    const out = path.join(outDir, 'env.json')
    const env: Record<string, string | undefined> = { ...process.env, PRELOAD_PROBE_OUT: out }
    if (runRoot === null) delete env.KAWAI_TEST_RUN_ROOT
    else env.KAWAI_TEST_RUN_ROOT = runRoot
    const proc = Bun.spawn([process.execPath, 'test', '--preload', PRELOAD, PROBE], {
      stdout: 'ignore',
      stderr: 'pipe',
      cwd: REPO_ROOT,
      env,
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`probe child exited ${exitCode}: ${stderr.slice(-2000)}`)
    }
    return JSON.parse(fs.readFileSync(out, 'utf8')) as ProbeSnapshot
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

describe('scripts/test-preload.ts', () => {
  test('under a run root every variable, HOME included, lands in one fresh per-file directory', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-probe-root-'))
    try {
      const snap = await runProbeChild(runRoot)
      const fileRoot = path.dirname(snap.home!)
      expect(path.basename(fileRoot)).toMatch(/^file-/)
      expect(path.dirname(fileRoot)).toBe(runRoot)
      expect(snap.home).toBe(path.join(fileRoot, 'home'))
      expect(fs.statSync(snap.home!).isDirectory()).toBe(true)
      expect(snap.claudeConfigDir).toBe(path.join(fileRoot, 'claude'))
      expect(snap.codexHome).toBe(path.join(fileRoot, 'codex'))
      expect(snap.logFile).toBe(path.join(fileRoot, 'agentboard.log'))
      expect(snap.dbPath).toBe(path.join(fileRoot, 'agentboard.db'))
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test("a bare `bun test` without a run root keeps the caller's HOME", async () => {
    const callerHome = process.env.HOME
    expect(callerHome).toBeTruthy()
    const snap = await runProbeChild(null)
    expect(snap.runRoot).toBeNull()
    expect(snap.home).toBe(callerHome)
  }, 30_000)
})
