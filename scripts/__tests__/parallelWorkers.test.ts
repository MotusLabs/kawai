// D2's worker-pid gate (parallel-suite design): `bun test --parallel=N` must
// run N worker processes at once. The lead's probe pinned their shape —
// `bun test --test-worker --isolate …`, children of the bun test root,
// reused across files. This test holds N barrier fixtures open at the same
// time and asserts both the distinct worker pids (the fixture's report
// carries its writer's pid) and the largest simultaneously-running file
// count equal N. Nothing asserts a duration, so host load cannot flake it:
// a wrong N fails slowly but correctly. The fixtures are generated into a
// temp cwd with no bunfig, so no preload applies to the spawned run.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The digest's barrier fixture in concatenation form: each file registers in
// PW_DIR/started, holds in PW_DIR/running until n files run at once (or every
// file has started), keeps sampling during a 300 ms hold so an extra
// concurrent file shows itself, then appends "<pid> <max>" to PW_DIR/report.
const FIXTURE = [
  "import { test } from 'bun:test'",
  "import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'",
  '',
  'const dir = process.env.PW_DIR as string',
  'const n = Number(process.env.PW_N)',
  'const total = Number(process.env.PW_TOTAL)',
  '',
  "test('holds until n files run at once', async () => {",
  '  const me = process.pid + "-" + import.meta.file',
  "  for (const sub of ['running', 'started']) mkdirSync(dir + '/' + sub, { recursive: true })",
  "  writeFileSync(dir + '/started/' + me, '')",
  "  writeFileSync(dir + '/running/' + me, '')",
  "  const count = (sub: string) => readdirSync(dir + '/' + sub).length",
  "  let max = count('running')",
  '  const deadline = Date.now() + 20_000',
  "  while (Date.now() < deadline && count('running') < n && count('started') < total) {",
  '    await Bun.sleep(20)',
  '    max = Math.max(max, count(\'running\'))',
  '  }',
  '  const holdEnd = Date.now() + 300',
  '  while (Date.now() < holdEnd) {',
  "    max = Math.max(max, count('running'))",
  '    await Bun.sleep(20)',
  '  }',
  "  rmSync(dir + '/running/' + me)",
  "  appendFileSync(dir + '/report', process.pid + ' ' + max + '\\n')",
  '}, 30_000)',
  '',
].join('\n')

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

for (const workers of [1, 2, 4]) {
  test(`bun test --parallel=${workers} runs ${workers} worker processes`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-workers-'))
    createdDirs.push(base)
    const fix = path.join(base, 'fix')
    const run = path.join(base, 'run')
    fs.mkdirSync(fix)
    fs.mkdirSync(run)
    const files: string[] = []
    for (let index = 0; index < workers + 2; index += 1) {
      fs.writeFileSync(path.join(fix, `f${index}.test.ts`), FIXTURE)
      files.push(`./f${index}.test.ts`)
    }
    const proc = Bun.spawn([process.execPath, 'test', `--parallel=${workers}`, ...files], {
      cwd: fix,
      env: { ...process.env, PW_DIR: run, PW_N: String(workers), PW_TOTAL: String(workers + 2) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const report = fs.existsSync(path.join(run, 'report'))
      ? fs
          .readFileSync(path.join(run, 'report'), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
      : []
    const pids = new Set(report.map((line) => Number(line.split(' ')[0])))
    const max = report.reduce((largest, line) => Math.max(largest, Number(line.split(' ')[1]) || 0), 0)
    if (exitCode !== 0 || pids.size !== workers || max !== workers) {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      console.error(`--parallel=${workers} exit=${exitCode} report=${JSON.stringify(report)}\n${out}${err}`)
    }
    expect(pids.size, `distinct worker pids for --parallel=${workers}`).toBe(workers)
    expect(max, `largest concurrent file count for --parallel=${workers}`).toBe(workers)
  }, 120_000)
}
