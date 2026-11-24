// prePushBunPin.test.ts — the pre-push hook's pinned-Bun rule
// (pre-push-bun-pin D1-D4, contract A2-A6, V1, V4). The V1 table seeds real
// records with checkRecords' own writer, gathers the certifying version with
// pre-push.ts's lookup (the running Bun, then the pin), and decides with
// decidePush. The A5 table pins every no-pin and equal-pin verdict to the
// lines the hook printed before the pin existed (origin/master 6b246650),
// apart from the pass line, which now names its record's Bun (A3). The A6
// table runs each missing-pass refusal through Kawai's effect classifier.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeHidden, type HiddenEntry } from '../../src/server/checks/checkKey'
import { writeRecord } from '../../src/server/checks/checkRecords'
import { classifyEffectFailure } from '../../src/server/plans/landing/effectOutcome'
import { decidePush, parseBunPin, settleFallback, type RefFacts } from '../lib/pushCheck'
import { treeRecordKey } from '../lib/treeRecord'
import { recordedBunFor } from '../pre-push'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const T = 'c'.repeat(40)
const RUNNING = Bun.version
// Versions guaranteed to differ from the running Bun and from each other.
const PIN = RUNNING === '1.0.0' ? '1.0.1' : '1.0.0'
const THIRD = RUNNING === '0.9.9' ? '0.9.8' : '0.9.9'
const HIDDEN: HiddenEntry[] = [{ path: 'src/hidden.ts', skipWorktree: true, assumeUnchanged: false }]

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-push-pin-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A full-pass record of tree T as `bun run check` under `bun` writes it. */
function seed(bun: string): void {
  writeRecord(dir, {
    key: treeRecordKey(T, bun),
    treeId: T,
    bun,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: '/somewhere',
    steps: [{ name: 'test', ms: 1 }],
  })
}

function commit(overrides: Partial<Extract<RefFacts, { kind: 'commit' }>> = {}): Extract<RefFacts, { kind: 'commit' }> {
  return { kind: 'commit', ref: 'refs/heads/main', commit: A, tree: T, bun: RUNNING, pin: null, recordedBun: null, head: A, dirtyPaths: [], ...overrides }
}

interface PinRow {
  id: string
  records: string[]
  /** The raw .bun-version content of the pushed tree; null when absent. */
  pinFile: string | null
  head: string
  dirty: string[]
  kind: 'pass' | 'refuse' | 'fallback'
  words: string[]
  absent: string[]
}

/** Gather the facts as pre-push.ts does, then decide. */
function decideRow(row: PinRow) {
  const pin = parseBunPin(row.pinFile)
  const recordedBun = recordedBunFor(dir, T, pin, Date.now())
  return decidePush([commit({ pin, recordedBun, head: row.head, dirtyPaths: row.dirty })], [])
}

function expectRow(row: PinRow): void {
  for (const bun of row.records) seed(bun)
  const verdict = decideRow(row)
  expect(verdict.kind).toBe(row.kind)
  const text = verdict.lines.join('\n')
  for (const word of row.words) expect(text).toContain(word)
  for (const word of row.absent) expect(text).not.toContain(word)
}

const MISMATCH_COMMAND = `\`bun run check\` under Bun ${PIN}`

describe('V1: the pinned-Bun decision table', () => {
  // @covers: dev-checks › Pushes require a full check of the pushed tree › Recorded pass under the pinned Bun
  test('V1.1 pin differs + record under the pin -> pass naming the pin', () => {
    expectRow({ id: 'V1.1', records: [PIN], pinFile: `${PIN}\n`, head: B, dirty: ['x'], kind: 'pass', words: [`recorded full pass for tree ${T} under Bun ${PIN}`], absent: [] })
  })

  test('V1.2 pin differs + record under the running Bun -> pass naming the running Bun', () => {
    expectRow({ id: 'V1.2', records: [RUNNING], pinFile: PIN, head: B, dirty: ['x'], kind: 'pass', words: [`under Bun ${RUNNING}`], absent: [] })
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Bun mismatch without a pass
  test('V1.3 pin differs + no record + clean HEAD -> refuse, no fallback', () => {
    expectRow({
      id: 'V1.3',
      records: [],
      pinFile: PIN,
      head: A,
      dirty: [],
      kind: 'refuse',
      words: [
        `pre-push: refs/heads/main ${A}: no full-check pass for tree ${T} under Bun ${RUNNING} or the pinned Bun ${PIN}`,
        `this hook runs Bun ${RUNNING}, so it runs no check`,
        `run ${MISMATCH_COMMAND} on a clean checkout of ${A}, then push`,
      ],
      absent: ['running `bun run check` on the clean tree'],
    })
  })

  test('V1.4 pin differs + no record + not HEAD -> refuse naming the pin', () => {
    expectRow({
      id: 'V1.4',
      records: [],
      pinFile: PIN,
      head: B,
      dirty: [],
      kind: 'refuse',
      words: [`or the pinned Bun ${PIN}; not checked out (HEAD is ${B}): check out ${A}, run ${MISMATCH_COMMAND} on the clean tree, then push`],
      absent: [],
    })
  })

  test('V1.5 pin differs + no record + dirty -> refuse naming the pin', () => {
    expectRow({
      id: 'V1.5',
      records: [],
      pinFile: PIN,
      head: A,
      dirty: ['scratch.txt'],
      kind: 'refuse',
      words: [`or the pinned Bun ${PIN}; checked out but the working tree is dirty: scratch.txt; commit or stash them, run ${MISMATCH_COMMAND}, then push`],
      absent: [],
    })
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Pin matching the current Bun
  test('V1.6 pin equal + no record + clean HEAD -> fallback', () => {
    expectRow({ id: 'V1.6', records: [], pinFile: `${RUNNING}\n`, head: A, dirty: [], kind: 'fallback', words: ['no recorded pass; running `bun run check` on the clean tree'], absent: ['pinned'] })
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Missing or malformed pin
  test('V1.7 no pin + no record + clean HEAD -> fallback', () => {
    expectRow({ id: 'V1.7', records: [], pinFile: null, head: A, dirty: [], kind: 'fallback', words: ['running `bun run check` on the clean tree'], absent: ['pinned'] })
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Missing or malformed pin
  test('V1.8 malformed pin + no record + clean HEAD -> fallback', () => {
    expectRow({ id: 'V1.8', records: [PIN], pinFile: `v${PIN}`, head: A, dirty: [], kind: 'fallback', words: ['running `bun run check` on the clean tree'], absent: ['pinned', 'recorded full pass'] })
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Pass under another Bun version
  test('V1.9 a record only under a third version -> treated as no record', () => {
    expectRow({ id: 'V1.9', records: [THIRD], pinFile: PIN, head: B, dirty: [], kind: 'refuse', words: ['no full-check pass', `pinned Bun ${PIN}`], absent: ['recorded full pass'] })
  })

  test('V1.10 a record only under a third version, no pin, clean HEAD -> fallback', () => {
    expectRow({ id: 'V1.10', records: [THIRD], pinFile: null, head: A, dirty: [], kind: 'fallback', words: ['no recorded pass'], absent: ['recorded full pass'] })
  })
})

describe('A2: the pin grammar', () => {
  test.each([
    ['a plain version', '1.4.3', '1.4.3'],
    ['a trailing newline', '1.4.3\n', '1.4.3'],
    ['surrounding whitespace', '  1.4.3 \r\n', '1.4.3'],
    ['multi-digit parts', '10.20.300', '10.20.300'],
    ['absent', null, null],
    ['empty', '', null],
    ['whitespace only', ' \n', null],
    ['a v prefix', 'v1.4.3', null],
    ['two parts', '1.4', null],
    ['four parts', '1.4.3.1', null],
    ['a prerelease suffix', '1.4.3-canary', null],
    ['two lines', '1.4.3\n1.4.4', null],
    ['a word', 'latest', null],
  ])('%s', (_name, content, pin) => {
    expect(parseBunPin(content)).toBe(pin)
  })
})

// A5: the verdicts before the pin existed, for an absent pin and a pin
// equal to the running Bun alike.
describe.each([
  ['no pin', null],
  ['a pin equal to the running Bun', RUNNING],
])('A5: unchanged verdicts with %s', (_name, pin) => {
  const fact = (overrides: Partial<Extract<RefFacts, { kind: 'commit' }>> = {}) => commit({ pin, ...overrides })

  test('a recorded pass passes, naming its Bun', () => {
    expect(decidePush([fact({ recordedBun: RUNNING, head: B, dirtyPaths: ['x'] })], [])).toEqual({
      kind: 'pass',
      lines: [`pre-push: refs/heads/main ${A}: recorded full pass for tree ${T} under Bun ${RUNNING}`],
    })
  })

  test('a clean unrecorded HEAD is the fallback', () => {
    expect(decidePush([fact(), fact({ ref: 'refs/tags/v1' })], [])).toEqual({
      kind: 'fallback',
      tree: T,
      commit: A,
      refs: ['refs/heads/main', 'refs/tags/v1'],
      lines: [`pre-push: refs/heads/main, refs/tags/v1 ${A}: no recorded pass; running \`bun run check\` on the clean tree`],
    })
  })

  test('not checked out and dirty refusals keep their wording', () => {
    expect(decidePush([fact({ head: null })], [])).toEqual({
      kind: 'refuse',
      lines: [`pre-push: refs/heads/main ${A}: no full-check pass for tree ${T}; not checked out (HEAD is unborn): check out ${A}, run \`bun run check\` on the clean tree, then push`],
    })
    expect(decidePush([fact({ dirtyPaths: ['a.ts'] })], [])).toEqual({
      kind: 'refuse',
      lines: [`pre-push: refs/heads/main ${A}: no full-check pass for tree ${T}; checked out but the working tree is dirty: a.ts; commit or stash them, run \`bun run check\`, then push`],
    })
  })

  test('hidden entries, deletions, unsupported refs, and Q1 keep their wording', () => {
    expect(decidePush([{ kind: 'deletion', ref: 'refs/heads/old' }, fact({ recordedBun: RUNNING })], HIDDEN)).toEqual({
      kind: 'refuse',
      lines: [`pre-push: refs/heads/main: refused: the index hides edits from the check. ${describeHidden(HIDDEN)} Then \`bun run check\` and push.`, 'pre-push: refs/heads/old: deletion, no check'],
    })
    expect(decidePush([{ kind: 'unsupported', ref: 'refs/tags/blob', sha: B }, fact()], [])).toEqual({
      kind: 'refuse',
      lines: [
        `pre-push: unsupported ref refs/tags/blob: ${B} is not a commit`,
        `pre-push: refs/heads/main ${A}: not checked: push refused anyway; push refs/heads/main separately to run its check`,
      ],
    })
  })

  test('the fallback settles on its exact key as before', () => {
    const verdict = { kind: 'fallback' as const, tree: T, commit: A, refs: ['refs/heads/main'], lines: [] }
    expect(settleFallback(verdict, 0, true, [])).toEqual({ code: 0, line: `pre-push: ${A}: full check passed for tree ${T}` })
    expect(settleFallback(verdict, 2, true, [])).toEqual({ code: 1, line: `pre-push: ${A}: the full check failed (exit 2); push refused` })
    expect(settleFallback(verdict, 0, false, ['s.txt'])).toEqual({
      code: 1,
      line: `pre-push: ${A}: the full check passed but recorded no pass for tree ${T} (the tree changed during the check: s.txt); push refused`,
    })
  })
})

describe('A6/V4: every missing-pass refusal is permanent for Kawai', () => {
  const permanent = (stderr: string) => classifyEffectFailure({ argv: ['git', 'push'], exitCode: 1, stderr })

  test('the classifier still reads network wording as transient (control)', () => {
    expect(permanent('fatal: unable to access: Connection timed out')).toBe('transient')
  })

  const cases: [string, RefFacts[], HiddenEntry[]][] = [
    ['mismatch on a clean HEAD', [commit({ pin: PIN })], []],
    ['mismatch, not checked out', [commit({ pin: PIN, head: B })], []],
    ['mismatch, unborn HEAD', [commit({ pin: PIN, head: null })], []],
    ['mismatch, dirty', [commit({ pin: PIN, dirtyPaths: ['scratch.txt'] })], []],
    ['not checked out', [commit({ head: B })], []],
    ['dirty', [commit({ dirtyPaths: ['scratch.txt'] })], []],
    ['equal pin, not checked out', [commit({ pin: RUNNING, head: B })], []],
    ['hidden entries', [commit({ pin: PIN })], HIDDEN],
    ['unsupported ref', [{ kind: 'unsupported', ref: 'refs/tags/blob', sha: B }], []],
    ['Q1 with a mismatch beside a clean HEAD', [commit({ ref: 'refs/heads/other', commit: B, pin: PIN, head: B }), commit()], []],
  ]
  test.each(cases)('%s', (_name, facts, hidden) => {
    const verdict = decidePush(facts, hidden)
    expect(verdict.kind).toBe('refuse')
    for (const line of verdict.lines) expect(permanent(line)).toBe('permanent')
    expect(permanent(verdict.lines.join('\n'))).toBe('permanent')
  })

  test('the fallback settlement refusals', () => {
    const verdict = { kind: 'fallback' as const, tree: T, commit: A, refs: ['refs/heads/main'], lines: [] }
    for (const settled of [settleFallback(verdict, 1, true, []), settleFallback(verdict, 0, false, ['s.txt'])]) {
      expect(settled.code).toBe(1)
      expect(permanent(settled.line)).toBe('permanent')
    }
  })
})
