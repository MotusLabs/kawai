// Mutant V2-failed-result-kept (closeout 7.3, contract A3): a failed run no
// longer removes the cache entry, so the failed result's predecessor is kept.
// Required: `DO3: a failed run after a cached success removes the entry and
// publishes last-valid values marked stale` fails. The whole reuse file runs
// so the log shows the blast radius: DO3 fails, its recovery row DO4 keeps
// passing (its final stored entry is identical), every other row passes.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecDiscovery.ts`
const logPath = `${repo}/openspec/changes/bounded-openspec-discovery/closeout/mutants/V2-failed-result-kept.log`
const before = '  } else {\n    cache.delete(worktreePath)\n  }'
const after = '  } else {\n    // mutant: a failed result keeps its entry\n  }'
const command = ['bun', 'test', 'src/server/__tests__/openspecDiscoveryReuse.test.ts', '--timeout', '20000']

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
      '# mutant V2-failed-result-kept',
      '# target: src/server/workspace/openspecDiscovery.ts',
      `# before: ${JSON.stringify(before)}`,
      `# after:  ${JSON.stringify(after)}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row DO3 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (DO3 failed, as required)' : 'SURVIVED (DO3 passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V2-failed-result-kept: killed' : 'V2-failed-result-kept: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
