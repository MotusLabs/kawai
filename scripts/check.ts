// check.ts - `bun run check` (check-dedup D3): lint, typecheck, and the unit
// suite against the working tree, reusing a recorded pass keyed by content
// (see scripts/lib/checkRun.ts). Failures are never recorded, and a pass
// records only when the tree is unchanged since the run started; --force
// runs every step regardless of records. `bun run test` stays the raw,
// uncached runner. `--no-retry` reaches the unit runner, which then reruns no
// failed real-tmux file; `--full-properties` runs every property test's
// declared case count and reuses only a pass that did (check-time-optimization
// D2–D4).

import { runGit } from '../src/server/git/gitCommand'
import { DEFAULT_STEPS, runCheck } from './lib/checkRun'

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const fullProperties = argv.includes('--full-properties')
const noRetry = argv.includes('--no-retry')
const steps = noRetry
  ? DEFAULT_STEPS.map((step) => (step.name === 'test' ? { ...step, command: [...step.command, '--no-retry'] } : step))
  : DEFAULT_STEPS

// The hook (and any caller) may sit in a subdirectory; every step and every
// git call runs from the repository root.
const root = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
if (!root.ok) {
  console.error(`check: not a git repository (${root.stderr.trim()})`)
  process.exit(2)
}
const cwd = root.stdout.trim()

// A pre-commit hook exports GIT_INDEX_FILE for the commit's index; the key's
// temporary-index copy reads it through the explicit option (it seeds the
// stat cache — the key is always the working tree's), while the steps run
// with every GIT_* variable stripped.
const hookIndex = process.env.GIT_INDEX_FILE || undefined
const outcome = await runCheck({ cwd, force, indexFile: hookIndex, steps, fullProperties })

if (outcome.kind === 'recorded') {
  console.log(`check: recorded pass ${outcome.record.at} in ${outcome.record.worktree}`)
  for (const step of outcome.record.steps) {
    console.log(`check:   ${step.name} ${step.ms}ms (from record)`)
  }
  process.exit(0)
}

if (outcome.kind === 'passed') {
  for (const step of outcome.steps) {
    console.log(`check: ${step.name} ok in ${step.ms}ms`)
  }
  if (outcome.recorded) {
    console.log(`check: pass recorded ${outcome.key.slice(0, 12)}…`)
  } else {
    console.log(`check: ${outcome.unrecordedBecause}; nothing recorded`)
  }
  process.exit(0)
}

if (outcome.kind === 'failed') {
  console.error(`check: ${outcome.step} failed (exit ${outcome.exitCode ?? 'signal'})`)
  process.exit(1)
}

console.error(outcome.message)
process.exit(2)
