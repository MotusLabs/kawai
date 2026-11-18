// Mutant V1-archive-walked (closeout 7.3, contract A3): the change walk no
// longer excludes `archive/`, so a rewrite under archive/ (FP8's row, which
// must stay equal) changes the fingerprint.
// Required: `FP8: a file under archive/ rewritten -> equal` fails.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecFingerprint.ts`
const logPath = `${repo}/openspec/changes/archive/2026-11-18-bounded-openspec-discovery/closeout/mutants/V1-archive-walked.log`
const before = "if (entry.isDirectory() && entry.name !== 'archive') {"
const after = 'if (entry.isDirectory()) {'
const command = ['bun', 'test', 'src/server/__tests__/openspecFingerprint.test.ts', '-t', 'FP8:', '--timeout', '20000']

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
      '# mutant V1-archive-walked',
      '# target: src/server/workspace/openspecFingerprint.ts',
      `# before: ${before}`,
      `# after:  ${after}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row FP8 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V1-archive-walked: killed' : 'V1-archive-walked: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
