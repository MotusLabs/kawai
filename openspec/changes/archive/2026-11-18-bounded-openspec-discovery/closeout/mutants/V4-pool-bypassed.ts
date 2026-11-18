// Mutant V4-pool-bypassed (closeout 7.3, contract A3): the pooled runner no
// longer routes through the pool, so a cold reconciliation starts every
// worktree's `openspec` process at once.
// Required: PC1 step 1 fails - the stub log's peak overlap exceeds 3
// (`PC1: 12 runs at most 3 at once, then none while unchanged, one after an
// edit, and all 12 after ten minutes`).
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecPool.ts`
const logPath = `${repo}/openspec/changes/archive/2026-11-18-bounded-openspec-discovery/closeout/mutants/V4-pool-bypassed.log`
const before = 'export const pooledOpenspecRunner: OpenspecCommandRunner = createPooledOpenspecRunner(openspecListPool)'
const after = 'export const pooledOpenspecRunner: OpenspecCommandRunner = (options) => runOpenspecList(options)'
const command = ['bun', 'test', 'src/server/__tests__/workspaceOpenspecComposition.integration.test.ts', '--timeout', '60000']

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
      '# mutant V4-pool-bypassed',
      '# target: src/server/workspace/openspecPool.ts',
      `# before: ${before}`,
      `# after:  ${after}`,
      `# command: ${command.join(' ')}`,
      '# required: PC1 step 1 fails on the stub log peak (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (PC1 step 1 failed, as required)' : 'SURVIVED (PC1 passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V4-pool-bypassed: killed' : 'V4-pool-bypassed: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
