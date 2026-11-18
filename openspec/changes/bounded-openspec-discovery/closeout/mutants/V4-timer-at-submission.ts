// Mutant V4-timer-at-submission (closeout 7.3, contract A3): the pooled
// runner charges the queue wait to the timeout, so the effective timeout
// starts at submission instead of at spawn.
// Required: `QT1: a run queued behind a full pool for longer than its timeout
// still succeeds when its process answers in time` fails.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecPool.ts`
const logPath = `${repo}/openspec/changes/bounded-openspec-discovery/closeout/mutants/V4-timer-at-submission.log`
const before = '  return (options) => pool.run(() => runner(options))'
const after =
  '  return (options) => {\n' +
  "    const submittedAt = Date.now()\n" +
  '    return pool.run(() => runner({ ...options, timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - submittedAt)) }))\n' +
  '  }'
const command = ['bun', 'test', 'src/server/__tests__/openspecPool.test.ts', '-t', 'QT1:', '--timeout', '20000']

const original = fs.readFileSync(target, 'utf8')
const hits = original.split(before).length - 1
if (hits !== 1) {
  console.error(`pattern found ${hits} times, expected exactly 1; aborting without patching`)
  process.exit(2)
}
fs.writeFileSync(target, original.replace(before, after))
let code = 1
try {
  const run = Bun.spawnSync(command, { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  const killed = run.exitCode !== 0
  fs.writeFileSync(
    logPath,
    [
      '# mutant V4-timer-at-submission',
      '# target: src/server/workspace/openspecPool.ts',
      `# before: ${before}`,
      `# after:  ${JSON.stringify(after)}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row QT1 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V4-timer-at-submission: killed' : 'V4-timer-at-submission: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
