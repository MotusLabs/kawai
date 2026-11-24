// prePush.integration.test.ts — the push hook end to end (per-result-suite
// task 3.2; the ADDED "Pushes require a full check of the pushed tree"
// scenarios; I1 and I2). Real `git push` to a local bare remote runs this
// checkout's scripts/pre-push.ts through core.hooksPath; the real
// scripts/check.ts runs the stub steps and writes the real records the hook
// reads. Commits that only set up a state use --no-verify inside the
// temporary repository, so the commit hook is not what a test measures.
// The pinned-Bun tests (pre-push-bun-pin V3) commit a .bun-version that is
// not the running Bun and seed records with checkRecords' own writer.
// @reads: AGENTS.md
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { writeRecord } from '../../src/server/checks/checkRecords'
import { createHookRepo, type HookRepo } from './helpers/hookRepo'
import { treeRecordKey } from '../lib/treeRecord'
import { dirtyPaths } from '../pre-push'

let fixture: HookRepo

beforeEach(() => {
  fixture = createHookRepo()
})

afterEach(() => {
  fixture.remove()
})

const FULL_CHECK_STEPS = ['step:lint', 'step:typecheck', 'step:test']
// A pin guaranteed to differ from the running Bun.
const PIN = Bun.version === '1.0.0' ? '1.0.1' : '1.0.0'

/** Commit a change without the commit hook; returns the new HEAD. */
function setUpCommit(relative: string, content: string, message = relative): string {
  fixture.write(relative, content)
  fixture.git(['add', relative])
  const result = fixture.commit(['--no-verify', '-m', message])
  if (result.code !== 0) throw new Error(result.output)
  fixture.takeLog()
  return fixture.git(['rev-parse', 'HEAD']).trim()
}

function remoteRef(ref: string): string | null {
  const line = fixture.git(['ls-remote', 'origin', ref]).trim()
  return line === '' ? null : line.split('\t')[0]
}

function recordCheck(): void {
  expect(fixture.check().code).toBe(0)
  expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
}

function editRecord(edit: (record: Record<string, unknown>) => string): void {
  const [name] = fixture.records()
  const file = path.join(fixture.repo, '.git', 'kawai-checks', name)
  fs.writeFileSync(file, edit(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>))
}

describe('the push hook in a temporary repository', () => {
  test('a recorded pass pushes without running checks', () => {
    const head = setUpCommit('src/shared/lone.ts', 'export const lone = 2\n')
    recordCheck()
    const result = fixture.push(['origin', 'main'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(result.output).toContain('recorded full pass')
    expect(remoteRef('refs/heads/main')).toBe(head)
  })

  test('an unchecked clean HEAD runs the full check, records its tree, and pushes (I2)', () => {
    const head = setUpCommit('src/shared/lone.ts', 'export const lone = 3\n')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(fixture.records()).toHaveLength(1)
    expect(remoteRef('refs/heads/main')).toBe(head)
  })

  test('a failing fallback check refuses the push', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 4\n')
    fixture.fail('test')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('the full check failed')
    expect(fixture.records()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test('an unchecked commit that is not checked out is refused, naming the commit and `bun run check`', () => {
    const older = setUpCommit('src/shared/lone.ts', 'export const lone = 5\n')
    setUpCommit('src/shared/leaf.ts', 'export const leaf = 1 // later\n')
    const result = fixture.push(['origin', `${older}:refs/heads/main`])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(`${older}: no full-check pass`)
    expect(result.output).toContain('not checked out')
    expect(result.output).toContain('`bun run check`')
    expect(fixture.takeLog()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test('an unchecked HEAD with a dirty working tree is refused, naming the dirty path', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 6\n')
    fixture.write('scratch.txt', 'wip\n')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('checked out but the working tree is dirty: scratch.txt')
    expect(fixture.takeLog()).toEqual([])
  })

  test('a staged rename lists both paths unmangled (F-u1)', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 16\n')
    fixture.git(['mv', 'src/shared/lone.ts', 'src/shared/moved-lone.ts'])
    // In -z format the old path is a separate token without an XY prefix;
    // a slice over every token cut its first three characters off.
    expect(dirtyPaths(fixture.repo)).toEqual(['src/shared/moved-lone.ts', 'src/shared/lone.ts'])
  })

  test('a staged rename whose old path has a space lists both paths unmangled (F-u1)', () => {
    setUpCommit('ab c.ts', 'export const spaced = 1\n')
    fixture.git(['mv', 'ab c.ts', 'moved.ts'])
    // The old path's third character is a space: if the rename's old-path
    // token were not consumed, the loop would read it as the next entry and
    // push its own slice — the mangled 'c.ts'.
    expect(dirtyPaths(fixture.repo)).toEqual(['moved.ts', 'ab c.ts'])
  })

  test('dirtyPaths returns null outside a repository (F1)', () => {
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside)
    // A failed status reads as dirty (fail closed) only after dirtyPaths
    // reports it; null is what separates "cannot tell" from "clean".
    expect(dirtyPaths(outside)).toBeNull()
  })

  test('two unchecked refs: both are buffered, the second is refused by id, and the clean HEAD is not checked (Q1)', () => {
    const side = setUpCommit('src/shared/lone.ts', 'export const lone = 7\n')
    fixture.git(['branch', 'side'])
    const head = setUpCommit('src/shared/leaf.ts', 'export const leaf = 1 // main\n')
    const result = fixture.push(['origin', 'main', 'side'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(`refs/heads/side ${side}: no full-check pass`)
    expect(result.output).toContain(`refs/heads/main ${head}: not checked: push refused anyway`)
    expect(fixture.takeLog()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test('an annotated tag pushes by its peeled commit tree', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 8\n')
    recordCheck()
    fixture.git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'tag', '-a', 'v1', '-m', 'v1'])
    fixture.git(['checkout', '--detach', 'HEAD~1'])
    const result = fixture.push(['origin', 'v1'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(remoteRef('refs/tags/v1')).not.toBeNull()
  })

  test('a tag of a blob is refused as an unsupported ref', () => {
    const blob = fixture.git(['hash-object', '-w', 'AGENTS.md']).trim()
    fixture.git(['tag', 'blobtag', blob])
    const result = fixture.push(['origin', 'blobtag'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(`unsupported ref refs/tags/blobtag: ${blob} is not a commit`)
  })

  test('a deletion-only push runs no check', () => {
    fixture.git(['branch', 'gone'])
    recordCheck()
    expect(fixture.push(['origin', 'gone']).code).toBe(0)
    fixture.fail('test')
    fixture.write('scratch.txt', 'wip\n')
    setUpCommit('src/shared/lone.ts', 'export const lone = 9\n')
    const result = fixture.push(['origin', '--delete', 'gone'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(result.output).toContain('deletion, no check')
    expect(remoteRef('refs/heads/gone')).toBeNull()
  })

  test.each([
    ['malformed JSON', () => '{ not json'],
    ['a key field naming another key', (record: Record<string, unknown>) => JSON.stringify({ ...record, key: 'f'.repeat(64) })],
    ['a treeId naming another tree', (record: Record<string, unknown>) => JSON.stringify({ ...record, treeId: 'e'.repeat(40) })],
    ['another Bun version', (record: Record<string, unknown>) => JSON.stringify({ ...record, bun: '0.0.1' })],
    ['an expired record', (record: Record<string, unknown>) => JSON.stringify({ ...record, at: '2000-01-01T00:00:00.000Z' })],
  ])('a record with %s counts as absent', (_name, edit) => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 10\n')
    recordCheck()
    editRecord(edit)
    fixture.write('scratch.txt', 'wip\n')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('no full-check pass')
  })

  test('a fallback check that changes the tree passes unrecorded, and the push is refused (exact key, I2)', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 11\n')
    fixture.dirty('test')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(result.output).toContain('the full check passed but recorded no pass for tree')
    expect(result.output).toContain('stray-test.txt')
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test.each([
    ['with a recorded pass', true],
    ['without a record', false],
  ])('a skip-worktree entry hiding an edit refuses the push %s (F1)', (_name, recorded) => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 12\n')
    if (recorded) recordCheck()
    fixture.git(['update-index', '--skip-worktree', 'src/shared/lone.ts'])
    fixture.write('src/shared/lone.ts', 'export const lone = 13 // hidden\n')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('`git update-index --no-skip-worktree -- src/shared/lone.ts`')
    expect(fixture.takeLog()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test('a commit through the partial hook path leaves no record, so its push from a dirty tree is refused (I1)', () => {
    fixture.write('src/shared/lone.ts', 'export const lone = 14\n')
    fixture.git(['add', 'src/shared/lone.ts'])
    expect(fixture.commit(['-m', 'lone']).code).toBe(0)
    expect(fixture.records()).toEqual([])
    fixture.write('scratch.txt', 'wip\n')
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('no full-check pass')
  })

  test('a message-only amend after a full pass pushes on the recorded pass without a check', () => {
    setUpCommit('src/shared/lone.ts', 'export const lone = 15\n')
    recordCheck()
    expect(fixture.commit(['--amend', '-m', 'lone, reworded']).code).toBe(0)
    fixture.takeLog()
    const result = fixture.push(['origin', 'main'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBe(fixture.git(['rev-parse', 'HEAD']).trim())
  })

  test('the shipped pre-push shim refuses with a message outside a repository (R6)', () => {
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside)
    const result = Bun.spawnSync(['sh', path.join(import.meta.dir, '..', '..', '.githooks', 'pre-push')], {
      cwd: outside,
      env: { PATH: process.env.PATH ?? '', HOME: fixture.root, GIT_CEILING_DIRECTORIES: fixture.root },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('pre-push: cannot resolve the repository root; push refused')
  })

  test('a working tree greener than the commit does not certify it: the push is refused', () => {
    fixture.write('src/shared/leaf.ts', 'export const leaf = 2 // staged, broken\n')
    fixture.git(['add', 'src/shared/leaf.ts'])
    fixture.write('src/shared/leaf.ts', 'export const leaf = 1 // working tree, fixed\n')
    expect(fixture.commit(['-m', 'leaf, broken in the commit']).code).toBe(0)
    fixture.takeLog()
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('checked out but the working tree is dirty: src/shared/leaf.ts')
    expect(fixture.takeLog()).toEqual([])
  })
})

describe('the push hook with a pinned Bun other than the running one', () => {
  /** A full-pass record of HEAD's tree as a check under `bun` writes it. */
  function seedPass(bun: string): void {
    const treeId = fixture.git(['rev-parse', 'HEAD^{tree}']).trim()
    writeRecord(path.join(fixture.repo, '.git', 'kawai-checks'), {
      key: treeRecordKey(treeId, bun),
      treeId,
      bun,
      platform: process.platform,
      arch: process.arch,
      at: new Date().toISOString(),
      worktree: fixture.repo,
      steps: [{ name: 'test', ms: 1 }],
    })
  }

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Recorded pass under the pinned Bun
  test('V3a a pass recorded under the pin pushes without running a check', () => {
    const head = setUpCommit('.bun-version', `${PIN}\n`)
    seedPass(PIN)
    const result = fixture.push(['origin', 'main'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(result.output).toContain(`recorded full pass for tree`)
    expect(result.output).toContain(`under Bun ${PIN}`)
    expect(remoteRef('refs/heads/main')).toBe(head)
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Bun mismatch without a pass
  test('V3b no pass on a clean HEAD is refused naming the pinned Bun, and no check step runs', () => {
    const head = setUpCommit('.bun-version', `${PIN}\n`)
    const result = fixture.push(['origin', 'main'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(`refs/heads/main ${head}: no full-check pass`)
    expect(result.output).toContain(`under Bun ${Bun.version} or the pinned Bun ${PIN}`)
    expect(result.output).toContain(`run \`bun run check\` under Bun ${PIN} on a clean checkout of ${head}, then push`)
    expect(fixture.takeLog()).toEqual([])
    expect(fixture.records()).toEqual([])
    expect(remoteRef('refs/heads/main')).toBeNull()
  })

  test('V3c the pin is read from the pushed commit, not from HEAD or the working tree', () => {
    const pinned = setUpCommit('.bun-version', `${PIN}\n`)
    fixture.git(['branch', 'pinned'])
    fixture.git(['rm', '-q', '.bun-version'])
    expect(fixture.commit(['--no-verify', '-m', 'unpin']).code).toBe(0)
    fixture.takeLog()
    const refused = fixture.push(['origin', 'pinned'])
    expect(refused.code).not.toBe(0)
    expect(refused.output).toContain(`refs/heads/pinned ${pinned}: no full-check pass`)
    expect(refused.output).toContain(`run \`bun run check\` under Bun ${PIN} on the clean tree`)
    expect(fixture.takeLog()).toEqual([])
    // HEAD's own tree has no pin: the clean-HEAD fallback runs as before.
    const pushed = fixture.push(['origin', 'main'])
    expect(pushed.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Pin matching the current Bun
  test('V3d a pin equal to the running Bun keeps the clean-HEAD fallback', () => {
    const head = setUpCommit('.bun-version', `${Bun.version}\n`)
    const result = fixture.push(['origin', 'main'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(remoteRef('refs/heads/main')).toBe(head)
  })
})
