// reads.test.ts — fixtures for the @reads header parser and the guard's
// scanner (per-result-suite task 1.1). Every fixture source is embedded as
// a string, so the repo-wide guard scan (task 1.2) sees only the assertion
// literals declared in the header below.
// @reads: AGENTS.md, CLAUDE.md, docs/**, .kawai/**, .github/**, openspec/**
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  READS_HEADER_MAX_LINE,
  WATCHED_ROOTS,
  declaresPath,
  listUnitTestFiles,
  parseReadsHeader,
  scanTestSources,
  undeclaredReads,
} from '../lib/reads'

describe('parseReadsHeader', () => {
  test('reads a comma-separated header of exact paths and globs', () => {
    expect(parseReadsHeader('// @reads: AGENTS.md, .kawai/groups/*.md')).toEqual([
      'AGENTS.md',
      '.kawai/groups/*.md',
    ])
  })

  test('accumulates several header lines and drops blank entries', () => {
    const source = '// @reads: AGENTS.md, , docs/**\n// @reads: .kawai/*.md\nconst x = 1'
    expect(parseReadsHeader(source)).toEqual(['AGENTS.md', 'docs/**', '.kawai/*.md'])
  })

  test('ignores a header past the first 20 lines', () => {
    const onLastHeaderLine = `${'\n'.repeat(READS_HEADER_MAX_LINE - 1)}// @reads: AGENTS.md`
    expect(parseReadsHeader(onLastHeaderLine)).toEqual(['AGENTS.md'])
    const oneLineTooLate = `${'\n'.repeat(READS_HEADER_MAX_LINE)}// @reads: AGENTS.md`
    expect(parseReadsHeader(oneLineTooLate)).toEqual([])
  })
})

describe('undeclaredReads', () => {
  test('an undeclared literal is reported with its path', () => {
    const source = `import fs from 'node:fs'\nconst text = fs.readFileSync('AGENTS.md', 'utf8')`
    expect(undeclaredReads(source)).toEqual(['AGENTS.md'])
  })

  test('a declared glob passes', () => {
    const source = [
      '// @reads: docs/**',
      `const text = fs.readFileSync('docs/guide.md', 'utf8')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual([])
  })

  test('a declared exact path covers itself but not siblings', () => {
    const source = [
      '// @reads: AGENTS.md',
      `const a = fs.readFileSync('AGENTS.md', 'utf8')`,
      `const b = fs.readFileSync('docs/guide.md', 'utf8')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['docs/guide.md'])
  })

  test('a temporary-directory path is ignored', () => {
    const source = [
      'import path from \'node:path\'',
      'const a = path.join(tmpdir(), \'docs/guide.md\')',
      'const b = path.join(mkdtempSync("prefix-"), \'AGENTS.md\')',
    ].join('\n')
    expect(undeclaredReads(source)).toEqual([])
  })

  test('a literal joined to an unrecognised base is ignored', () => {
    const source = [
      'import path from \'node:path\'',
      `const p = path.join(repo, '.kawai/groups/devs.md')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual([])
  })

  test('a literal joined to a repository-root helper is a read', () => {
    const source = [
      'import path from \'node:path\'',
      `const a = path.join(repoRoot, '.github/workflows/ci.yml')`,
      `const b = path.resolve(REPO_ROOT, 'docs/guide.md')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['.github/workflows/ci.yml', 'docs/guide.md'])
  })

  test('a template literal joined to a repository-root helper is a read', () => {
    const helper = 'const p = `${repoRoot}/docs/guide.md`'
    expect(undeclaredReads(helper)).toEqual(['docs/guide.md'])
    const temp = 'const p = `${mkdtempSync("p-")}/docs/guide.md`'
    expect(undeclaredReads(temp)).toEqual([])
  })

  test('a literal joined onto import.meta.dir resolves against the file’s directory', () => {
    const source = [
      'import path from \'node:path\'',
      'const a = path.join(import.meta.dir, \'../../../AGENTS.md\')',
      'const b = path.resolve(__dirname, \'../../../.kawai/groups\')',
      'const c = path.join(import.meta.dir, \'../shared.ts\')',
    ].join('\n')
    expect(undeclaredReads(source, 'src/server/__tests__/fixture.test.ts')).toEqual([
      'AGENTS.md',
      '.kawai/groups',
    ])
  })

  test('a process.cwd() base is the repository root and segments fold', () => {
    const source = [
      'import path from \'node:path\'',
      `const p = path.resolve(process.cwd(), '.kawai', 'groups')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['.kawai/groups'])
  })

  test('consecutive literal segments fold into one path', () => {
    const source = [
      'import path from \'node:path\'',
      `const p = path.join(repoRoot, 'docs', 'guide.md')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['docs/guide.md'])
  })

  test('a conditional literal nested in a join call is a read (F5)', () => {
    const source = [
      'import path from \'node:path\'',
      `const p = path.join(repoRoot, flag ? 'AGENTS.md' : 'x')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['AGENTS.md'])
  })

  test('a literal nested in a join call argument is a read (F5)', () => {
    const source = [
      'import path from \'node:path\'',
      `const p = path.join(repoRoot, pick('AGENTS.md'))`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual(['AGENTS.md'])
  })

  test('literals inside a joined array are reads (F5)', () => {
    const source = `const p = ['AGENTS.md', x].join('\\n')`
    expect(undeclaredReads(source)).toEqual(['AGENTS.md'])
  })

  test('a concatenation from a base is a read', () => {
    const source = [
      `const a = repoRoot + '/AGENTS.md'`,
      `const b = import.meta.dir + '/../../../docs/guide.md'`,
    ].join('\n')
    expect(undeclaredReads(source, 'src/server/__tests__/fixture.test.ts')).toEqual([
      'AGENTS.md',
      'docs/guide.md',
    ])
  })

  test('a comment mention is ignored', () => {
    const source = '// the suite reads docs/guide.md through the helper\nconst n = 1'
    expect(undeclaredReads(source)).toEqual([])
  })

  test('every watched root is detected', () => {
    const samples: Array<[string, string]> = [
      ['AGENTS.md', 'AGENTS.md'],
      ['CLAUDE.md', 'CLAUDE.md'],
      ['docs/', 'docs/guide.md'],
      ['.kawai/', '.kawai/groups/devs.md'],
      ['.github/', '.github/workflows/ci.yml'],
      ['openspec/', 'openspec/changes/demo/proposal.md'],
    ]
    for (const [root, sample] of samples) {
      expect(WATCHED_ROOTS).toContain(root)
      const source = `const p = read('${sample}')`
      expect(undeclaredReads(source)).toEqual([sample])
    }
  })

  test('a path outside the watched roots is ignored', () => {
    const source = [
      `const a = fs.readFileSync('package.json', 'utf8')`,
      `const b = fs.readFileSync('src/server/index.ts', 'utf8')`,
    ].join('\n')
    expect(undeclaredReads(source)).toEqual([])
  })
})

describe('scanTestSources', () => {
  test('names the file and the path for each undeclared read', () => {
    const violations = scanTestSources([
      { file: 'a.test.ts', content: `read('AGENTS.md')` },
      { file: 'b.test.tsx', content: `// @reads: docs/**\nread('docs/z.md')\nread('openspec/o.md')` },
    ])
    expect(violations).toEqual([
      { file: 'a.test.ts', path: 'AGENTS.md' },
      { file: 'b.test.tsx', path: 'openspec/o.md' },
    ])
  })
})

describe('declaresPath', () => {
  test('a single-level glob covers one segment only', () => {
    expect(declaresPath(['.kawai/groups/*.md'], '.kawai/groups/lead.md')).toBe(true)
    expect(declaresPath(['.kawai/groups/*.md'], '.kawai/groups/sub/lead.md')).toBe(false)
  })

  test('a recursive glob covers nesting', () => {
    expect(declaresPath(['docs/**'], 'docs/a/b.md')).toBe(true)
    expect(declaresPath(['docs/**'], 'docs')).toBe(false)
  })

  test('a ./ prefix on either side is ignored', () => {
    expect(declaresPath(['./AGENTS.md'], 'AGENTS.md')).toBe(true)
    expect(declaresPath(['AGENTS.md'], './AGENTS.md')).toBe(true)
  })
})

describe('listUnitTestFiles', () => {
  test('lists test files from the four corpus locations under a root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reads-corpus-'))
    try {
      for (const file of [
        'src/server/__tests__/a.test.ts',
        'src/server/__tests__/b.integration.test.ts',
        'src/client/__tests__/c.test.tsx',
        'scripts/__tests__/d.test.ts',
        'src/shared/__tests__/e.test.ts',
        'src/server/__tests__/helper.ts',
        'src/server/other.test.ts',
      ]) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), 'export {}\n')
      }
      expect(listUnitTestFiles(root)).toEqual([
        'scripts/__tests__/d.test.ts',
        'src/client/__tests__/c.test.tsx',
        'src/server/__tests__/a.test.ts',
        'src/server/__tests__/b.integration.test.ts',
        'src/shared/__tests__/e.test.ts',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})



