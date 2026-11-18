// Mutant V3-slot-leaked-on-throw (closeout 7.3, contract A3): a throwing task
// no longer releases its slot, so the pool leaks capacity and queued tasks
// never start.
// Required: `PL1: at most 3 run at once, each result reaches its own caller
// once, a throw releases its slot (300 cases, seed 0x0a5e)` fails (settled
// count falls short of n, or the row times out while waiters hang).
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecPool.ts`
const logPath = `${repo}/openspec/changes/bounded-openspec-discovery/closeout/mutants/V3-slot-leaked-on-throw.log`
const before = '    try {\n      return await task()\n    } finally {\n      this.release()\n    }'
const after = '    const value = await task()\n    this.release()\n    return value'
const command = ['bun', 'test', 'src/server/__tests__/openspecPool.test.ts', '-t', 'PL1:', '--timeout', '20000']

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
      '# mutant V3-slot-leaked-on-throw',
      '# target: src/server/workspace/openspecPool.ts',
      `# before: ${JSON.stringify(before)}`,
      `# after:  ${JSON.stringify(after)}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row PL1 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V3-slot-leaked-on-throw: killed' : 'V3-slot-leaked-on-throw: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
