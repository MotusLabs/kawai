// Mutant V1-mtime-dropped (closeout 7.3, contract A3): the change-walk record
// drops mtime, so a same-size rewrite with a new mtime (FP2's row) is no
// longer detected.
// Required: `FP2: tasks.md rewritten, same size, new mtime -> differs` fails.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecFingerprint.ts`
const logPath = `${repo}/openspec/changes/bounded-openspec-discovery/closeout/mutants/V1-mtime-dropped.log`
const before = 'push(`f\\t${childRelative}\\t${typeOf(entry)}\\t${stats.size}\\t${stats.mtimeMs}`)'
const after = 'push(`f\\t${childRelative}\\t${typeOf(entry)}\\t${stats.size}`)'
const command = ['bun', 'test', 'src/server/__tests__/openspecFingerprint.test.ts', '-t', 'FP2:', '--timeout', '20000']

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
      '# mutant V1-mtime-dropped',
      '# target: src/server/workspace/openspecFingerprint.ts',
      `# before: ${before}`,
      `# after:  ${after}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row FP2 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V1-mtime-dropped: killed' : 'V1-mtime-dropped: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
