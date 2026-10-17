// The backstop, the named round-7 regressions, and linearity
// (execution-safety-recovery task 3.6, D4, D8): each list entry in an
// unmodeled segment adds one `unclassified-send` row naming it and a proven
// non-send adds none; R1 and R2 never read allowed; the noise controls stay
// allowed and the reads unrecorded; withholding and redaction grow linearly,
// asserted as a time ratio, never a wall-clock bound. Reserved example names.
import { describe, expect, test } from 'bun:test'
import { backstopEntries } from '../outbound/backstop'
import { BACKSTOP_ENTRIES, type BackstopEntry } from '../outbound/proof'
import { redact } from '../outbound/redact'
import { parseSends } from '../outbound/sends'
import { withholdReason } from '../outbound/withhold'
import { judged, verdictOf } from './outboundClassifyFacts'

/** One unmodeled segment per list entry, naming that entry alone. */
const ENTRY_SEGMENTS: Record<BackstopEntry, string> = {
  'git-push': './run.sh git push',
  gh: './run.sh gh',
  curl: './run.sh curl',
  wget: './run.sh wget',
  http: './run.sh http',
  https: './run.sh https',
  ssh: 'ssh host.example.org uptime',
  scp: 'scp file host.example.org:x',
  sftp: 'sftp host.example.org',
  rsync: 'rsync -a dir host.example.org:x',
  nc: 'nc host.example.org 80',
  ncat: 'ncat host.example.org 80',
  socat: 'socat - TCP:host.example.org:80',
  ftp: 'ftp host.example.org',
  telnet: 'telnet host.example.org',
  mail: './run.sh mailx',
  publish: 'make publish',
  'image-push': './run.sh docker push',
  url: './run.sh https://host.example.org/x',
  'command-not-literal': '$CMD x',
  'dev-tcp': 'exec 3<>/dev/tcp/host.example.org/80',
}

const rowsOf = (command: string) => judged(command).map(row => `${row.rule} ${row.verdict} ${row.destination}`)

describe('the backstop (task 3.6)', () => {
  test('each list entry in an unmodeled segment adds one row naming it', () => {
    for (const entry of BACKSTOP_ENTRIES) {
      expect({ entry, rows: rowsOf(ENTRY_SEGMENTS[entry]) }).toEqual({
        entry, rows: [`unclassified-send unknown-destination unresolved:unclassified:${entry}`],
      })
    }
  })

  test('several entries in one segment add one row each, in list order, once', () => {
    expect(judged('./run.sh git push https://host.example.org curl curl').map(row => row.destination)).toEqual([
      'unresolved:unclassified:git-push', 'unresolved:unclassified:curl', 'unresolved:unclassified:url',
    ])
    // A pipeline's other commands are searched with the segment.
    expect(judged('cat notes | ./run.sh')).toEqual([])
    expect(judged('echo https://host.example.org | ./run.sh').map(row => row.destination)).toEqual(['unresolved:unclassified:url'])
  })

  test('a proven non-send adds none, whatever its text names', () => {
    for (const command of [
      'git status', 'git log --grep "git push"', 'curl https://host.example.org/page', 'grep -rn "git push" docs',
      'echo https://host.example.org', 'ls -la', 'docker images', 'npm test', 'rg -n curl src',
    ]) {
      expect({ command, rows: parseSends(command, '/repo') }).toEqual({ command, rows: [] })
    }
  })

  test('a send tool whose verb a non-literal word hides adds its own entry', () => {
    expect(rowsOf('git $V')).toEqual(['unclassified-send unknown-destination unresolved:unclassified:git-push'])
    expect(rowsOf('docker "$V" registry.example.internal/a:1')).toContain('unclassified-send unknown-destination unresolved:unclassified:image-push')
    expect(rowsOf('npm $(verb)')).toEqual(['unclassified-send unknown-destination unresolved:unclassified:publish'])
  })

  test('backstop rows never read allowed and name no command text', () => {
    for (const entry of BACKSTOP_ENTRIES) {
      for (const row of judged(ENTRY_SEGMENTS[entry])) {
        expect(row.verdict).toBe('unknown-destination')
        expect(row.destination).toMatch(/^unresolved:unclassified:[a-z-]+$/)
      }
    }
  })
})

describe('round 7 regressions and controls (task 3.6)', () => {
  test('R1: env --chdir to a directory without the repository records a row that is not allowed', () => {
    for (const command of ['env --chdir /tmp git push fork', 'env --chdir=/tmp git push fork', 'env -C/tmp git push fork', 'env -iC /tmp git push fork']) {
      const rows = judged(command)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.verdict).not.toBe('allowed')
    }
  })

  test('R2: git -c a=b -C "$D" push reads unknown-destination', () => {
    expect(verdictOf('git -c a=b -C "$D" push')).toMatchObject({ rule: 'git-push', verdict: 'unknown-destination' })
  })

  test('noise controls stay allowed', () => {
    for (const command of ['git push origin x', 'cd /repo && git push', 'git -C /repo push', 'gh pr create --body-file f', 'gh pr merge 1']) {
      expect({ command, best: verdictOf(command)?.verdict }).toEqual({ command, best: 'allowed' })
    }
  })

  test('reads stay unrecorded', () => {
    for (const command of ['git status', 'curl https://host.example.org/page', 'grep -rn "git push" docs']) {
      expect({ command, rows: judged(command) }).toEqual({ command, rows: [] })
    }
  })
})

/** The best of several timings of `run` (warm, least noisy). */
function bestTime(run: () => unknown): number {
  run()
  let best = Infinity
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

describe('linearity (task 3.6, D8)', () => {
  // A linear pass doubles; the quadratic header redaction it replaced
  // quadrupled. "About twice" leaves room for timer noise, never for n².
  const RATIO = 2.8

  test('redaction: 40,000 headers take at most about twice 20,000', () => {
    const headers = (n: number) => `curl ${'-H "X-Trace-Id: v1" '.repeat(n)}https://example.internal/hook`
    const small = headers(20_000)
    const large = headers(40_000)
    expect(bestTime(() => redact(large)) / bestTime(() => redact(small))).toBeLessThan(RATIO)
  })

  test('withholding: a full pass over 40,000 header words takes at most about twice 20,000', () => {
    // No early trigger: every word is read.
    const words = (n: number) => `echo ${'X-Trace-Id v1 '.repeat(n)}`
    expect(withholdReason(words(10))).toBeNull()
    expect(bestTime(() => withholdReason(words(40_000))) / bestTime(() => withholdReason(words(20_000)))).toBeLessThan(RATIO)
  })

  test('the backstop: 40,000 words take at most about twice 20,000', () => {
    const text = (n: number) => 'word https://host.example.org '.repeat(n)
    expect(bestTime(() => backstopEntries(text(40_000))) / bestTime(() => backstopEntries(text(20_000)))).toBeLessThan(RATIO)
  })
})
