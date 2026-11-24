// Mutant V1-root-entries-skipped (closeout 7.3, contract A3): the entries of
// `<root>/openspec/` are no longer fingerprinted, so a `config.yaml` rewrite
// (FP9's row) is no longer detected.
// Required: `FP9: config.yaml rewritten -> differs` fails.
import fs from 'node:fs'

const repo = '/home/coder/kawai/.worktrees/bounded-openspec-discovery'
const target = `${repo}/src/server/workspace/openspecFingerprint.ts`
const logPath = `${repo}/openspec/changes/archive/2026-11-18-bounded-openspec-discovery/closeout/mutants/V1-root-entries-skipped.log`
const before =
  '      for (const entry of await fs.readdir(openspecDir, { withFileTypes: true })) {\n' +
  '        const stats = await statForRecord(path.join(openspecDir, entry.name))\n' +
  '        push(`r\\t${entry.name}\\t${typeOf(entry)}\\t${stats.size}\\t${stats.mtimeMs}`)\n' +
  '      }\n'
const after = '      // mutant: root entries are not fingerprinted\n'
const command = ['bun', 'test', 'src/server/__tests__/openspecFingerprint.test.ts', '-t', 'FP9:', '--timeout', '20000']

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
      '# mutant V1-root-entries-skipped',
      '# target: src/server/workspace/openspecFingerprint.ts',
      `# before: ${JSON.stringify(before)}`,
      `# after:  ${JSON.stringify(after)}`,
      `# command: ${command.join(' ')}`,
      '# required: the named row FP9 fails (the mutant is killed)',
      '',
      run.stdout.toString() + run.stderr.toString(),
      `verdict: ${killed ? 'KILLED (named row failed, as required)' : 'SURVIVED (named row passed - NOT detected)'}`,
      '',
    ].join('\n'),
  )
  console.log(killed ? 'V1-root-entries-skipped: killed' : 'V1-root-entries-skipped: SURVIVED')
  code = killed ? 0 : 1
} finally {
  fs.writeFileSync(target, original)
}
process.exit(code)
