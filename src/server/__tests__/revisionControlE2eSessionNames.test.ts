// revisionControlE2eSessionNames.test.ts - The revision-control walkthrough's
// session names never collide with another e2e spec's (revision-control 9.5,
// CI fix rounds 1 and 2). CI's fixture step runs every spec against one server,
// and specs pick their sessions with Playwright's `hasText`, a case-insensitive
// substring match taking the first row. A walkthrough name that contains
// another spec's name, or is contained in one, makes that spec drive this
// walkthrough's team. 'Revision lead' broke chat-task-revision E09, and
// 'Holdwalk implementer' broke plan-execution's 'Walk implementer'.
// @reads: tests/e2e/**
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const E2E = path.resolve(import.meta.dir, '..', '..', '..', 'tests', 'e2e')
const WALKTHROUGH = 'chat-plan-revision-control.spec.ts'

/** Every session display name a spec creates: `createChat(page, root, 'Name', …)` or the New Session dialog's Display Name. */
function sessionNames(source: string): string[] {
  const created = [...source.matchAll(/createChat\(\s*page\s*,\s*[^,]+,\s*'([^']+)'/g)].map(match => match[1]!)
  const typed = [...source.matchAll(/getByLabel\('Display Name'\)\.fill\('([^']+)'\)/g)].map(match => match[1]!)
  return [...created, ...typed]
}

/** The pairs where one name is a case-insensitive substring of the other, as `hasText` matches them. */
function overlaps(ours: string[], theirs: Array<{ file: string; name: string }>): string[] {
  const found: string[] = []
  for (const name of ours) {
    for (const other of theirs) {
      const a = name.toLowerCase()
      const b = other.name.toLowerCase()
      if (a.includes(b) || b.includes(a)) found.push(`${name} ~ ${other.name} (${other.file})`)
    }
  }
  return found
}

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => path.join(entry.parentPath, entry.name))
}

test('the overlap rule reads hasText as a case-insensitive substring in both directions', () => {
  const others = [{ file: 'a.spec.ts', name: 'Walk implementer' }, { file: 'b.spec.ts', name: 'Revision lead' }]
  expect(overlaps(['Holdwalk implementer'], others)).toEqual(['Holdwalk implementer ~ Walk implementer (a.spec.ts)'])
  expect(overlaps(['Revision lead'], others)).toEqual(['Revision lead ~ Revision lead (b.spec.ts)'])
  expect(overlaps(['lead'], others)).toEqual(['lead ~ Revision lead (b.spec.ts)'])
  expect(overlaps(['Pausecase developer'], others)).toEqual([])
  expect(sessionNames("await createChat(page, root, 'One', 'devs')\nawait dialog.getByLabel('Display Name').fill('Two')")).toEqual(['One', 'Two'])
})

test('the revision-control walkthrough names its sessions so no other e2e spec’s hasText lookup can match them', () => {
  const files = specFiles(E2E)
  const ours = sessionNames(readFileSync(path.join(E2E, WALKTHROUGH), 'utf8'))
  expect(ours.length).toBeGreaterThanOrEqual(2)
  const theirs = files
    .filter(file => path.basename(file) !== WALKTHROUGH)
    .flatMap(file => sessionNames(readFileSync(file, 'utf8')).map(name => ({ file: path.relative(E2E, file), name })))
  // The scan reaches the specs that collided before (non-vacuous).
  expect(theirs.map(entry => entry.name)).toEqual(expect.arrayContaining(['Revision lead', 'Walk implementer']))
  expect(overlaps(ours, theirs)).toEqual([])
})
