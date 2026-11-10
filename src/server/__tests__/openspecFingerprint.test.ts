// openspecFingerprint.test.ts - The FP table (bounded-openspec-discovery
// design.md): each row varies one fingerprint input from the same base
// fixture and states whether the fingerprint equals the base's.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fingerprintOpenSpecInputs,
  OPENSPEC_FINGERPRINT_MAX_RECORDS,
} from '../workspace/openspecFingerprint'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    const changes = path.join(root, 'wt', 'openspec', 'changes')
    if (fs.existsSync(changes)) fs.chmodSync(changes, 0o755)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const FIXED = new Date('2026-01-01T00:00:00Z')

/**
 * Base fixture: an outer directory with its own `openspec/` (the ancestor
 * root FP11 falls back to, identical to the worktree's) holding a worktree `wt` with its own root,
 * `config.yaml`, two active changes, and one archived change.
 */
function baseFixture(): { root: string; wt: string; openspec: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-fp-'))
  roots.push(root)
  const wt = path.join(root, 'wt')
  const openspec = path.join(wt, 'openspec')
  // The ancestor's root is an exact copy, so FP11 differs only by the root path.
  for (const tree of [path.join(root, 'openspec'), openspec]) {
    write(path.join(tree, 'config.yaml'), 'schema: spec-driven\n')
    for (const change of ['alpha', 'beta']) {
      write(path.join(tree, 'changes', change, 'proposal.md'), `# ${change}\n`)
      write(path.join(tree, 'changes', change, 'tasks.md'), '- [ ] 1.1 one\n')
      write(path.join(tree, 'changes', change, 'specs', 'a', 'spec.md'), '# spec\n')
    }
    write(path.join(tree, 'changes', 'archive', '2026-01-01-old', 'tasks.md'), '- [x] 1.1 done\n')
  }
  write(path.join(wt, 'src', 'x.ts'), 'export {}\n')
  // Pin every mtime so a row's own change is the only difference.
  const pin = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) pin(full)
      fs.utimesSync(full, FIXED, FIXED)
    }
  }
  pin(root)
  return { root, wt, openspec }
}

type Expectation = 'equal' | 'differs' | 'null'

interface Row {
  id: string
  variation: string
  apply: (fixture: { root: string; wt: string; openspec: string }) => void
  expected: Expectation
}

const LATER = new Date('2026-01-02T00:00:00Z')

const ROWS: Row[] = [
  { id: 'FP1', variation: 'none (fingerprint taken twice)', apply: () => {}, expected: 'equal' },
  {
    id: 'FP2',
    variation: 'tasks.md rewritten, same size, new mtime',
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'changes', 'alpha', 'tasks.md')
      fs.writeFileSync(file, '- [x] 1.1 one\n')
      fs.utimesSync(file, LATER, LATER)
    },
    expected: 'differs',
  },
  {
    id: 'FP3',
    variation: 'tasks.md rewritten, different size, mtime restored',
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'changes', 'alpha', 'tasks.md')
      fs.writeFileSync(file, '- [x] 1.1 one\n- [ ] 1.2 two\n')
      fs.utimesSync(file, FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP4',
    variation: "a file added under an active change's specs/",
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'changes', 'alpha', 'specs', 'a', 'extra.md')
      fs.writeFileSync(file, 'x\n')
      fs.utimesSync(file, FIXED, FIXED)
      fs.utimesSync(path.dirname(file), FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP5',
    variation: 'a file removed from an active change',
    apply: ({ openspec }) => {
      const dir = path.join(openspec, 'changes', 'beta')
      fs.rmSync(path.join(dir, 'proposal.md'))
      fs.utimesSync(dir, FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP6',
    variation: 'a new change directory under changes/',
    apply: ({ openspec }) => {
      const dir = path.join(openspec, 'changes', 'gamma')
      fs.mkdirSync(dir)
      fs.utimesSync(dir, FIXED, FIXED)
      fs.utimesSync(path.join(openspec, 'changes'), FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP7',
    variation: 'an active change moved into archive/',
    apply: ({ openspec }) => {
      const changes = path.join(openspec, 'changes')
      fs.renameSync(path.join(changes, 'beta'), path.join(changes, 'archive', '2026-01-02-beta'))
      fs.utimesSync(changes, FIXED, FIXED)
      fs.utimesSync(path.join(changes, 'archive'), FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP8',
    variation: 'a file under archive/ rewritten',
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'changes', 'archive', '2026-01-01-old', 'tasks.md')
      fs.writeFileSync(file, '- [x] 1.1 done, and more text\n')
      fs.utimesSync(file, LATER, LATER)
    },
    expected: 'equal',
  },
  {
    id: 'FP9',
    variation: 'config.yaml rewritten',
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'config.yaml')
      fs.writeFileSync(file, 'schema: spec-driven\ncontext: x\n')
      fs.utimesSync(file, FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP10',
    variation: 'a file outside openspec/ (src/x.ts) rewritten',
    apply: ({ wt }) => {
      const file = path.join(wt, 'src', 'x.ts')
      fs.writeFileSync(file, 'export const changed = true\n')
      fs.utimesSync(file, LATER, LATER)
    },
    expected: 'equal',
  },
  {
    id: 'FP11',
    variation: "the worktree's openspec/ removed, so an ancestor's root resolves",
    apply: ({ openspec, wt }) => {
      fs.rmSync(openspec, { recursive: true, force: true })
      fs.utimesSync(wt, FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP13',
    variation: 'a plain file named changes/notes.txt added',
    apply: ({ openspec }) => {
      const file = path.join(openspec, 'changes', 'notes.txt')
      fs.writeFileSync(file, 'n\n')
      fs.utimesSync(file, FIXED, FIXED)
      fs.utimesSync(path.join(openspec, 'changes'), FIXED, FIXED)
    },
    expected: 'differs',
  },
  {
    id: 'FP14',
    variation: 'an active change holding 5,001 files',
    apply: ({ openspec }) => {
      const dir = path.join(openspec, 'changes', 'alpha', 'many')
      fs.mkdirSync(dir)
      for (let index = 0; index <= OPENSPEC_FINGERPRINT_MAX_RECORDS; index += 1) {
        fs.writeFileSync(path.join(dir, `f${index}`), '')
      }
    },
    expected: 'null',
  },
  {
    id: 'FP15',
    variation: 'the root unreadable (chmod 000 on openspec/changes)',
    apply: ({ openspec }) => {
      fs.chmodSync(path.join(openspec, 'changes'), 0o000)
    },
    expected: 'null',
  },
]

describe('fingerprintOpenSpecInputs FP table', () => {
  for (const row of ROWS) {
    test(`${row.id}: ${row.variation} -> ${row.expected}`, async () => {
      const fixture = baseFixture()
      const base = await fingerprintOpenSpecInputs(fixture.wt)
      expect(base).toMatch(/^[0-9a-f]{64}$/)
      row.apply(fixture)
      const after = await fingerprintOpenSpecInputs(fixture.wt)
      if (row.expected === 'null') {
        expect(after).toBeNull()
      } else if (row.expected === 'equal') {
        expect(after).toBe(base)
      } else {
        expect(after).not.toBeNull()
        expect(after).not.toBe(base)
      }
    })
  }

  test('FP12: no openspec/ anywhere up to the filesystem root, taken twice -> equal, and not null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-fp-none-'))
    try {
      const first = await fingerprintOpenSpecInputs(root)
      const second = await fingerprintOpenSpecInputs(root)
      expect(first).not.toBeNull()
      expect(second).toBe(first)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
