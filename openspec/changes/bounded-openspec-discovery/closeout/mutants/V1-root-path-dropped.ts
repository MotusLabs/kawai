// Mutant V1-root-path-dropped (closeout 7.3, contract A3): the record no
// longer names the resolved root's path, so FP11's move of the root (the
// worktree's openspec/ removed, an ancestor's root resolving instead) is no
// longer detected.
// Required: `FP11: the worktree's openspec/ removed, so an ancestor's root resolves -> differs` fails.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecFingerprint.ts`
const logPath = `${repo}/openspec/changes/bounded-openspec-discovery/closeout/mutants/V1-root-path-dropped.log`
const before = 'push(`root\\t${root}`)'
const after = "push('root')"
const command = ['bun', 'test', 'src/server/__tests__/openspecFingerprint.test.ts', '-t', 'FP11:', '--timeout', '20000']

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
      '# mutant V1-root-path-dropped',
      '# target: src/server/workspace/openspecFingerprint.ts',
      `# before: ${before}`,
      `# after:  ${after}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row FP11 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V1-root-path-dropped: killed' : 'V1-root-path-dropped: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
