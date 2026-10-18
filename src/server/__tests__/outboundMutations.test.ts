// Generated variants of every allowed corpus send (execution-safety-recovery
// task 3.6): no mutation reads `allowed`, and every one records a row. The
// mutations are the ones the four checks exist for — a variable, a command
// substitution, or a glob in place of one word; an unknown option or wrapper
// inserted; a directory option in each of its spellings (`-Cdir`,
// `--chdir=dir`, `--chdir dir`, clustered); and an unevaluated builtin, a
// subshell, or a brace group before the send. Reserved example names.
import { describe, expect, test } from 'bun:test'
import { parseCall } from '../outbound/segments'
import { judged } from './outboundClassifyFacts'

/** Sends the shared facts judge `allowed`. */
const ALLOWED = [
  'git push',
  'git push origin main',
  'git push origin x',
  'git push mirror',
  'git -C /repo push',
  'cd /repo && git push',
  'gh pr create --title x',
  'gh pr create --body-file f',
  'gh pr merge 1',
  'gh repo rename new-name',
  'gh api -X POST repos/acme/kawai/issues',
  'curl -d x https://example.internal/x',
  'npm publish --registry https://npm.example.internal',
  'docker push registry.example.internal/team/app:2',
  'helm push chart.tgz oci://charts.example.internal/x',
  'twine upload --repository-url https://pypi.example.internal dist/pkg.whl',
  'bash -c "git push"',
  'sudo curl -d x https://example.internal/hook',
]

/** Directory options in every spelling, each naming a directory with no repository. */
const DIRECTORY_SPELLINGS = [
  'env -C/tmp', 'env -C /tmp', 'env --chdir=/tmp', 'env --chdir /tmp', 'env -iC /tmp', 'env -iC/tmp',
  'sudo -D/tmp', 'sudo -D /tmp', 'sudo --chdir=/tmp', 'sudo --chdir /tmp',
]

const BEFORE = ['eval "$X"; ', 'source env.sh; ', '. ./env.sh; ', 'trap "$X" EXIT; ', '(true); ', '{ true; }; ', '(cd /repo); ', 'exec 3>&1; ']

/** One-word replacements: each word of the command in turn. */
function wordMutations(command: string): string[] {
  const words = parseCall(command).commands.flatMap(cmd => cmd.words)
  const out: string[] = []
  for (const word of words) {
    // A glob suffix on a quoted script would unquote it into other words.
    const glob = word.text.includes(' ') ? [] : [`${word.text}*`]
    for (const replacement of ['$V', '"$V"', '$(v)', '`v`', '*', ...glob, '${V:-x}']) {
      out.push(command.slice(0, word.start) + replacement + command.slice(word.end))
    }
  }
  return out
}

/** The command words of the send itself (after `cd … &&`, inside `bash -c`). */
function sendParts(command: string): { prefix: string; send: string; suffix: string } {
  const shell = /^(bash -c ")(.*)(")$/.exec(command)
  if (shell !== null) return { prefix: shell[1]!, send: shell[2]!, suffix: shell[3]! }
  const chain = /^(cd \S+ && )(.*)$/.exec(command)
  if (chain !== null) return { prefix: chain[1]!, send: chain[2]!, suffix: '' }
  return { prefix: '', send: command, suffix: '' }
}

function shapeMutations(command: string): string[] {
  const { prefix, send, suffix } = sendParts(command)
  const [head, ...rest] = send.split(' ')
  const tail = rest.join(' ')
  const out = [
    `${prefix}${head} --zz-unknown ${tail}${suffix}`,
    `${prefix}sudo -Z ${send}${suffix}`,
    `${prefix}env --zz ${send}${suffix}`,
    `${prefix}nice --zz ${send}${suffix}`,
    `${prefix}xargs --zz ${send}${suffix}`,
    `${prefix}mywrap ${send}${suffix}`,
    `${prefix}/opt/tools/${head} ${tail}${suffix}`,
  ]
  // Only git and gh read their destination from the directory; an absolute
  // `git -C` after the inserted option already names the repository again.
  const cwdBound = (head === 'git' || head === 'gh') && !send.includes(' -C ')
  if (cwdBound) for (const spelling of DIRECTORY_SPELLINGS) out.push(`${prefix}${spelling} ${send}${suffix}`)
  if (head === 'git' && cwdBound) {
    for (const option of ['-C/tmp', '-C /tmp', '-C /repo -C /tmp', '-C/repo -C/tmp', '-c a=b', '-c a=b -C /repo']) out.push(`${prefix}git ${option} ${tail}${suffix}`)
  }
  for (const before of BEFORE) out.push(`${before}${command}`)
  return out
}

describe('generated mutations of allowed sends (task 3.6)', () => {
  test('every base send reads allowed', () => {
    for (const command of ALLOWED) {
      expect({ command, verdicts: judged(command).map(row => row.verdict) }).toEqual({ command, verdicts: ['allowed'] })
    }
  })

  test('no mutation reads allowed, and every one records a row', () => {
    const failures: string[] = []
    let count = 0
    for (const base of ALLOWED) {
      for (const mutation of [...wordMutations(base), ...shapeMutations(base)]) {
        count++
        const rows = judged(mutation)
        if (rows.length === 0) failures.push(`no row: ${mutation}`)
        const allowed = rows.filter(row => row.verdict === 'allowed')
        if (allowed.length > 0) failures.push(`allowed: ${mutation} → ${allowed.map(row => row.destination).join(', ')}`)
      }
    }
    expect(failures.join('\n')).toBe('')
    expect(count).toBeGreaterThan(500)
  })
})
