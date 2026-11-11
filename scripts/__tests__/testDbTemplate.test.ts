// testDbTemplate.test.ts - The template database through the real unit
// runner (check-time-optimization D5, tasks 5.1, 5.4): the runner exports
// KAWAI_TEST_DB_TEMPLATE to every child, naming a migrated template that
// exists for the run, and TD1, after a run over two fixture files — one
// migration test (initDatabase on a new file) and one helper user
// (freshTestDatabase) — pre-migration backups exist only in the migration
// test's root.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTemplateBuild } from '../lib/testDbTemplatePaths'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'testDbTemplate')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface ProbeLine {
  name: string
  backups: string[]
  template: string | null
  templateExists: boolean
}

// @covers: dev-checks › Test databases start from a migrated template › A migration test
test('TD1 through the real runner: pre-migration backups exist only in the migration test\'s root; every child sees the template', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-template-probe-'))
  dirs.push(outDir)
  const out = path.join(outDir, 'probe.jsonl')
  const proc = Bun.spawn({
    cmd: [process.execPath, RUNNER, path.join(FIXTURES, 'migrationUser.test.ts'), path.join(FIXTURES, 'helperUser.test.ts')],
    cwd: REPO_ROOT,
    env: { ...process.env, KAWAI_TEST_WORKERS: '2', KAWAI_PROBE_OUT: out },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(proc.stderr).text()
  await new Response(proc.stdout).text()
  expect(await proc.exited, (await stderr).slice(-2000)).toBe(0)
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProbeLine)
  const byName = new Map(lines.map((line) => [line.name, line]))
  expect([...byName.keys()].sort()).toEqual(['helper', 'migration'])
  const preMigration = (line: ProbeLine) => line.backups.filter((name) => name.includes('pre-migration-'))
  // Rotation keeps the newest few; any at all shows the migrations ran.
  expect(preMigration(byName.get('migration')!).length).toBeGreaterThan(0)
  expect(preMigration(byName.get('helper')!)).toEqual([])
  for (const line of lines) {
    expect(line.template).not.toBeNull()
    expect(path.basename(line.template!)).toBe('template.db')
    expect(line.templateExists).toBe(true)
  }
}, 60_000)

test('a template build that fails throws its own message out of the spawn, and a good one returns the template path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-template-spawn-'))
  dirs.push(dir)
  // A run root that is a file: the build cannot create the database.
  const notADir = path.join(dir, 'file')
  fs.writeFileSync(notADir, '')
  expect(() => spawnTemplateBuild(notADir)).toThrow('[test-runner] the template test database did not build')
  const runRoot = path.join(dir, 'run')
  fs.mkdirSync(runRoot)
  const built = spawnTemplateBuild(runRoot)
  expect(built).toBe(path.join(runRoot, 'template.db'))
  expect(fs.existsSync(built)).toBe(true)
}, 60_000)
