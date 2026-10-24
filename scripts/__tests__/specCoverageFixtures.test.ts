// specCoverageFixtures.test.ts — the @covers guard's grammar and rule over
// fixture trees (independent-verification tasks 5.1–5.2, D8). Every test
// builds a disposable tree with the repository's openspec layout, runs the
// same runSpecCoverageGuard the real-repository guard test runs, and asserts
// the failures. The real repository's own run lives in
// specCoverageGuard.test.ts.
// @reads: openspec/**
// (the openspec path literals below name fixture trees only; the test that
// reads the real repository's openspec lives in specCoverageGuard.test.ts)
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runSpecCoverageGuard, type CoverageFailure } from '../lib/specCoverage'

function makeTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-'))
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// A minimal main spec: one requirement with one scenario.
function mainSpec(requirement: string, scenario: string): string {
  return `# Cap Specification\n\n### Requirement: ${requirement}\n\n#### Scenario: ${scenario}\n- **WHEN** a\n- **THEN** b\n`
}

// A minimal active-change delta section.
function deltaSection(section: string, requirement: string, scenario: string): string {
  return `# Spec Delta\n\n## ${section} Requirements\n\n### Requirement: ${requirement}\n\n#### Scenario: ${scenario}\n- **WHEN** a\n- **THEN** b\n`
}

// A minimal archive directory with one delta spec.
function archiveSpec(
  root: string,
  date: string,
  change: string,
  requirement: string,
  scenario: string
): void {
  write(
    root,
    `openspec/changes/archive/${date}-${change}/specs/cap/spec.md`,
    deltaSection('ADDED', requirement, scenario)
  )
}

const CONFIG = JSON.stringify({ since: '2026-01-01', exempt: [] })

// An annotated test file, as the guard scans them.
function annotatedTest(root: string, relative: string, name: string, body: string): void {
  write(root, relative, `// @covers: ${name}\n${body}\n`)
}

function failuresOf(root: string): CoverageFailure[] {
  return runSpecCoverageGuard(root).failures
}

describe('the @covers grammar (5.1)', () => {
  // @covers: spec-coverage › Tests name the scenarios they cover › Annotation resolves
  test('an annotation above its test resolves against the main specs', () => {
    const root = makeTree()
    write(
      root,
      'openspec/specs/cap/spec.md',
      mainSpec('Widget serves', 'It serves') +
        '\n#### Scenario: Also serves\n- **WHEN** c\n- **THEN** d\n'
    )
    write(root, 'openspec/coverage.json', CONFIG)
    // Stacked annotations, blank lines, and comments in between are fine (E4).
    write(
      root,
      'src/a.test.ts',
      [
        '// @covers: cap › Widget serves › It serves',
        '',
        '// a plain comment between annotations',
        '// @covers: cap › Widget serves › Also serves',
        "test('covers it', () => {})",
        '',
      ].join('\n')
    )
    expect(failuresOf(root)).toEqual([])
  })

  // @covers: spec-coverage › Tests name the scenarios they cover › Annotation for an active change
  test('an annotation naming an active change scenario resolves', () => {
    const root = makeTree()
    write(root, 'openspec/coverage.json', CONFIG)
    write(
      root,
      'openspec/changes/in-flight/specs/cap/spec.md',
      deltaSection('ADDED', 'Fresh rule', 'Fresh scenario')
    )
    annotatedTest(root, 'src/a.test.ts', 'cap › Fresh rule › Fresh scenario', "test('x', () => {})")
    expect(failuresOf(root)).toEqual([])
  })

  // @covers: spec-coverage › Tests name the scenarios they cover › Stale annotation
  test('an annotation naming only what an archived delta holds fails as stale', () => {
    const root = makeTree()
    write(root, 'openspec/coverage.json', CONFIG)
    // The main spec renamed the scenario; the archive still holds the old name.
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'Renamed scenario'))
    archiveSpec(root, '2026-02-01', 'renamer', 'Widget serves', 'Old name')
    annotatedTest(root, 'src/a.test.ts', 'cap › Widget serves › Old name', "test('x', () => {})")
    const failures = failuresOf(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('annotation-unresolved')
    expect(failures[0]!.file).toBe('src/a.test.ts')
    expect(failures[0]!.line).toBe(1)
  })

  // @covers: spec-coverage › Tests name the scenarios they cover › Annotation away from a test
  test('an annotation away from a test fails naming its file and line', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    write(
      root,
      'src/a.test.ts',
      [
        '// @covers: cap › Widget serves › It serves',
        "describe('not a test', () => {})",
        '',
        'const later = 1',
      ].join('\n')
    )
    const failures = failuresOf(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('annotation-not-above-test')
    expect(failures[0]!.file).toBe('src/a.test.ts')
    expect(failures[0]!.line).toBe(1)
  })

  // @covers: spec-coverage › Tests name the scenarios they cover › Name containing the separator
  test('a spec name containing the separator fails naming the spec file and line', () => {
    const root = makeTree()
    write(root, 'openspec/coverage.json', CONFIG)
    write(
      root,
      'openspec/specs/cap/spec.md',
      `# Cap Specification\n\n### Requirement: Bad › Name\n\n#### Scenario: It serves\n- **WHEN** a\n- **THEN** b\n`
    )
    const failures = failuresOf(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('separator-in-name')
    expect(failures[0]!.file).toBe('openspec/specs/cap/spec.md')
    expect(failures[0]!.line).toBe(3)
  })

  test('test modifiers open the annotated call', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    write(
      root,
      'src/a.test.ts',
      [
        '// @covers: cap › Widget serves › It serves',
        "test.skip('skipped', () => {})",
        '// @covers: cap › Widget serves › It serves',
        "it.each([[1]])('each case %d', () => {})",
        '',
      ].join('\n')
    )
    expect(failuresOf(root)).toEqual([])
  })
})

describe('newly archived changes have covered scenarios (5.2)', () => {
  // @covers: spec-coverage › Newly archived changes have covered scenarios › Covered archive
  test('a covered archive passes', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    archiveSpec(root, '2026-02-01', 'widget-lore', 'Widget serves', 'It serves')
    annotatedTest(root, 'src/a.test.ts', 'cap › Widget serves › It serves', "test('x', () => {})")
    expect(failuresOf(root)).toEqual([])
  })

  // @covers: spec-coverage › Newly archived changes have covered scenarios › Uncovered scenario
  test('an uncovered scenario of a new archive fails naming the scenario and its change', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    archiveSpec(root, '2026-02-01', 'widget-lore', 'Widget serves', 'It serves')
    const failures = failuresOf(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('uncovered-scenario')
    expect(failures[0]!.message).toContain('cap › Widget serves › It serves')
    expect(failures[0]!.message).toContain('widget-lore')
  })

  // @covers: spec-coverage › Newly archived changes have covered scenarios › Older archives
  test('an archive older than since is not required', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    archiveSpec(root, '2020-12-31', 'ancient-lore', 'Widget serves', 'It serves')
    expect(failuresOf(root)).toEqual([])
  })

  // @covers: spec-coverage › Newly archived changes have covered scenarios › Exempt change
  test('an exempt change is not required, and its archived name still exists', () => {
    const root = makeTree()
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    write(root, 'openspec/coverage.json', JSON.stringify({ since: '2026-01-01', exempt: ['widget-lore'] }))
    archiveSpec(root, '2026-02-01', 'widget-lore', 'Widget serves', 'It serves')
    expect(failuresOf(root)).toEqual([])
  })

  // @covers: spec-coverage › Newly archived changes have covered scenarios › Stale exemption
  test('a stale exemption fails naming the entry', () => {
    const root = makeTree()
    write(root, 'openspec/coverage.json', JSON.stringify({ since: '2026-01-01', exempt: ['ghost-change'] }))
    const failures = failuresOf(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('stale-exemption')
    expect(failures[0]!.message).toContain('ghost-change')
  })

  // @covers: spec-coverage › Newly archived changes have covered scenarios › Scenario since removed or renamed
  test('a scenario since removed or renamed is not required under its old name', () => {
    const root = makeTree()
    // The main spec no longer holds the archived requirement at all.
    write(root, 'openspec/specs/cap/spec.md', mainSpec('Other rule', 'It serves'))
    write(root, 'openspec/coverage.json', CONFIG)
    archiveSpec(root, '2026-02-01', 'widget-lore', 'Widget serves', 'It serves')
    expect(failuresOf(root)).toEqual([])
  })

  test('a missing or malformed coverage.json fails closed', () => {
    const missing = makeTree()
    write(missing, 'openspec/specs/cap/spec.md', mainSpec('Widget serves', 'It serves'))
    const missingFailures = failuresOf(missing)
    expect(missingFailures).toHaveLength(1)
    expect(missingFailures[0]!.kind).toBe('config')

    const malformed = makeTree()
    write(malformed, 'openspec/coverage.json', JSON.stringify({ since: '2026-1-1', exempt: [] }))
    const malformedFailures = failuresOf(malformed)
    expect(malformedFailures).toHaveLength(1)
    expect(malformedFailures[0]!.kind).toBe('config')
  })
})
