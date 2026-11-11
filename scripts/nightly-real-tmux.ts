// nightly-real-tmux.ts - The nightly real-tmux run (check-time-optimization
// D7). `run` executes every real-tmux file through the unit-suite runner, one
// runner per file so one failing file never hides the others, and writes a
// Markdown report naming each failing test. `report` files that report as a
// GitHub issue: a comment on the open issue labeled `nightly-real-tmux`, or a
// new issue when none is open. The workflow
// (.github/workflows/nightly-real-tmux.yml) calls both; the decisions here
// are pure functions over injected effects so they are tested without
// GitHub or tmux.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REAL_TMUX_FILES } from './planBatches'

export const NIGHTLY_LABEL = 'nightly-real-tmux'
export const NIGHTLY_ISSUE_TITLE = 'Nightly real-tmux run failed'
export const FORCED_FAILURE_TITLE = 'forced nightly failure'

/** Every real-tmux file, as the repo-relative paths the runner takes. */
export function nightlyFiles(): string[] {
  return REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`)
}

/** The tests a `bun test` output names as failed, in output order, once each. */
export function failingTests(output: string): string[] {
  const names: string[] = []
  for (const line of output.split('\n')) {
    const match = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$/.exec(line.trimEnd())
    if (match && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

export interface FileResult {
  file: string
  exitCode: number
  failures: string[]
}

export function formatReport(results: FileResult[], runUrl: string): string {
  const failed = results.filter((result) => result.exitCode !== 0)
  const lines = [`Run: ${runUrl}`, '', `${failed.length} of ${results.length} real-tmux files failed.`, '']
  for (const result of failed) {
    lines.push(`- \`${result.file}\` (exit ${result.exitCode})`)
    if (result.failures.length === 0) lines.push('  - no `(fail)` line; see the run log')
    for (const name of result.failures) lines.push(`  - ${name}`)
  }
  return `${lines.join('\n')}\n`
}

/** A test file that always fails, for the forced-failure dispatch (task 2.2). */
export function writeForcedFailureFile(dir: string): string {
  const file = path.join(dir, 'nightly-forced-failure.test.ts')
  fs.writeFileSync(
    file,
    `import { test } from 'bun:test'\ntest('${FORCED_FAILURE_TITLE}', () => {\n  throw new Error('forced by the workflow input')\n})\n`
  )
  return file
}

export type RunFile = (file: string) => Promise<{ exitCode: number; output: string }>

export async function runNightly(files: string[], runFile: RunFile): Promise<FileResult[]> {
  const results: FileResult[] = []
  for (const file of files) {
    const { exitCode, output } = await runFile(file)
    results.push({ file, exitCode, failures: failingTests(output) })
  }
  return results
}

export type Gh = (args: string[]) => Promise<string>

/** Comment on the open nightly issue, or open one when none is open. */
export async function fileReport(gh: Gh, bodyFile: string): Promise<{ action: 'comment' | 'create'; target: string }> {
  const open = (
    await gh(['issue', 'list', '--label', NIGHTLY_LABEL, '--state', 'open', '--json', 'number', '--jq', '.[].number'])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
  if (open.length > 0) {
    const target = String(open[0])
    await gh(['issue', 'comment', target, '--body-file', bodyFile])
    return { action: 'comment', target }
  }
  await gh(['label', 'create', NIGHTLY_LABEL, '--force', '--color', 'B60205', '--description', 'Nightly real-tmux run failures'])
  const url = await gh(['issue', 'create', '--title', NIGHTLY_ISSUE_TITLE, '--label', NIGHTLY_LABEL, '--body-file', bodyFile])
  return { action: 'create', target: url.trim() }
}

async function spawnCollect(cmd: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
  const echo = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> => {
    let text = ''
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      sink.write(chunk)
      text += decoder.decode(chunk, { stream: true })
    }
    return text
  }
  const [out, err] = await Promise.all([echo(proc.stdout, process.stdout), echo(proc.stderr, process.stderr)])
  return { exitCode: await proc.exited, output: `${out}\n${err}` }
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2)
  const reportPath = process.env.NIGHTLY_REPORT
  if (!reportPath) throw new Error('NIGHTLY_REPORT must name the report file')
  if (command === 'run') {
    const files = nightlyFiles()
    if (process.env.KAWAI_NIGHTLY_FORCE_FAILURE === 'true') {
      files.push(writeForcedFailureFile(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-nightly-'))))
    }
    const results = await runNightly(files, (file) => spawnCollect(['bun', 'scripts/test-runner.ts', file]))
    const runUrl = process.env.NIGHTLY_RUN_URL ?? '(local run)'
    fs.writeFileSync(reportPath, formatReport(results, runUrl))
    const failed = results.filter((result) => result.exitCode !== 0).length
    console.log(`nightly-real-tmux: ${results.length - failed} passed, ${failed} failed`)
    return failed === 0 ? 0 : 1
  }
  if (command === 'report') {
    const gh: Gh = async (args) => {
      const { exitCode, output } = await spawnCollect(['gh', ...args])
      if (exitCode !== 0) throw new Error(`gh ${args.join(' ')} failed (${exitCode})`)
      return output.trim()
    }
    const outcome = await fileReport(gh, reportPath)
    console.log(`nightly-real-tmux: ${outcome.action} ${outcome.target}`)
    return 0
  }
  throw new Error('usage: nightly-real-tmux.ts run|report')
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error)
      process.exit(1)
    }
  )
}
