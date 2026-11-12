// @reads: .github/workflows/nightly-real-tmux.yml
// nightlyRealTmux.test.ts - The nightly real-tmux run (check-time-optimization
// D7, tasks 2.1–2.2): every real-tmux file runs, one failing file never hides
// the others, the report names each failing test and the run, and the
// failure is filed as a comment on the open `nightly-real-tmux` issue or as a
// new issue. The workflow is read as YAML so a schedule, trigger, or step
// that drifts from the script fails here; the dispatched runs are the live
// evidence (the change's result).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REAL_TMUX_FILES } from '../planBatches'
import {
  FORCED_FAILURE_TITLE,
  NIGHTLY_ISSUE_TITLE,
  NIGHTLY_LABEL,
  failingTests,
  fileReport,
  formatReport,
  nightlyFiles,
  runNightly,
  writeForcedFailureFile,
  type Gh,
} from '../nightly-real-tmux'

const WORKFLOW = '.github/workflows/nightly-real-tmux.yml'

function fakeGh(openIssues: number[]): { gh: Gh; calls: string[][] } {
  const calls: string[][] = []
  const gh: Gh = async (args) => {
    calls.push(args)
    if (args[0] === 'issue' && args[1] === 'list') return openIssues.join('\n')
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/99\n'
    return ''
  }
  return { gh, calls }
}

describe('nightly real-tmux run', () => {
  test('the run covers every real-tmux file, by its repo-relative path', () => {
    expect(nightlyFiles()).toEqual(REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`))
    for (const file of nightlyFiles()) expect(fs.existsSync(file)).toBe(true)
  })

  test('a failing file does not stop the files after it, and each failing test is named', async () => {
    const ran: string[] = []
    const results = await runNightly(['a.test.ts', 'b.test.ts', 'c.test.ts'], async (file) => {
      ran.push(file)
      if (file === 'b.test.ts') {
        return { exitCode: 1, output: '(pass) x\n(fail) suite > one [12.00ms]\n(fail) suite > two\n(fail) suite > one\n' }
      }
      return { exitCode: 0, output: '(pass) y\n' }
    })
    expect(ran).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
    expect(results.map((result) => result.exitCode)).toEqual([0, 1, 0])
    expect(results[1].failures).toEqual(['suite > one', 'suite > two'])
  })

  test('failingTests reads only (fail) lines and strips the duration', () => {
    expect(failingTests('(fail) a > b [1.50s]\n  (fail) indented\n(pass) c\nerror: (fail) d\n(fail) e [3ms]\n')).toEqual([
      'a > b',
      'e',
    ])
  })

  test('the report names the run, each failed file, and its failing tests', () => {
    const report = formatReport(
      [
        { file: 'a.test.ts', exitCode: 0, failures: [] },
        { file: 'b.test.ts', exitCode: 1, failures: ['suite > one'] },
        { file: 'c.test.ts', exitCode: 2, failures: [] },
      ],
      'https://example.invalid/run/1'
    )
    expect(report).toBe(
      [
        'Run: https://example.invalid/run/1',
        '',
        '2 of 3 real-tmux files failed.',
        '',
        '- `b.test.ts` (exit 1)',
        '  - suite > one',
        '- `c.test.ts` (exit 2)',
        '  - no `(fail)` line; see the run log',
        '',
      ].join('\n')
    )
  })

  test('the forced-failure file fails under bun test with its own title', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-nightly-test-'))
    try {
      const file = writeForcedFailureFile(dir)
      const result = Bun.spawnSync(['bun', 'test', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).not.toBe(0)
      expect(failingTests(`${result.stdout}\n${result.stderr}`)).toEqual([FORCED_FAILURE_TITLE])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // @covers: dev-checks › A nightly run executes every real-tmux file › A nightly failure
  test('with no open nightly issue, the failure opens one with the label and the report', async () => {
    const { gh, calls } = fakeGh([])
    const outcome = await fileReport(gh, '/tmp/report.md')
    expect(outcome).toEqual({ action: 'create', target: 'https://github.com/o/r/issues/99' })
    expect(calls.at(-1)).toEqual([
      'issue',
      'create',
      '--title',
      NIGHTLY_ISSUE_TITLE,
      '--label',
      NIGHTLY_LABEL,
      '--body-file',
      '/tmp/report.md',
    ])
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'comment')).toBe(false)
  })

  // @covers: dev-checks › A nightly run executes every real-tmux file › A repeated failure
  test('with an open nightly issue, the failure comments on the oldest one instead of opening another', async () => {
    const { gh, calls } = fakeGh([42, 17])
    const outcome = await fileReport(gh, '/tmp/report.md')
    expect(outcome).toEqual({ action: 'comment', target: '17' })
    expect(calls).toEqual([
      ['issue', 'list', '--label', NIGHTLY_LABEL, '--state', 'open', '--json', 'number', '--jq', '.[].number'],
      ['issue', 'comment', '17', '--body-file', '/tmp/report.md'],
    ])
  })

  test('the workflow runs daily and on dispatch, may write issues, and runs then reports through the script', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(WORKFLOW, 'utf8')) as {
      on: { schedule: { cron: string }[]; workflow_dispatch: { inputs: Record<string, unknown> }; push?: unknown }
      permissions: Record<string, string>
      jobs: { 'real-tmux': { steps: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] } }
    }
    expect(workflow.on.schedule).toHaveLength(1)
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['force_failure'])
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' })
    const steps = workflow.jobs['real-tmux'].steps
    const run = steps.find((step) => step.run === 'bun scripts/nightly-real-tmux.ts run')
    expect(run?.env?.KAWAI_NIGHTLY_FORCE_FAILURE).toContain('inputs.force_failure')
    const report = steps.find((step) => step.run?.includes('bun scripts/nightly-real-tmux.ts report'))
    expect(report?.if).toBe('failure()')
    expect(steps.some((step) => step.run?.includes('apt-get install -y tmux'))).toBe(true)
  })
})
