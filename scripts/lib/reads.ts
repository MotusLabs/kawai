// reads.ts — runtime-read declarations and their guard (per-result-suite D3).
//
// A unit test file that reads a repository file at runtime declares the path
// or glob in an `@reads` header comment within its first 20 lines:
//
//   // @reads: AGENTS.md, .kawai/groups/*.md
//
// The guard scans a test file's source for string literals naming a
// repository path under AGENTS.md, CLAUDE.md, docs/, .kawai/, .github/, or
// openspec/, and reports those its header does not cover. It is a heuristic
// for the common form — a literal path — and reads the source through the
// TypeScript parser, so comment mentions never count. A literal is a
// candidate when it appears on its own (tests run from the repository root,
// so a root-relative literal resolves there) or is joined onto a
// repository-root helper such as `repoRoot`; literals joined onto
// `tmpdir()`/`mkdtemp` results or onto any other base are fixture paths and
// are ignored. A test that builds paths dynamically declares them by hand.

import ts from 'typescript'

export const READS_HEADER_MAX_LINE = 20

// Repository locations whose runtime reads a test must declare. File roots
// match exactly; directory roots match everything beneath them.
export const WATCHED_ROOTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'docs/',
  '.kawai/',
  '.github/',
  'openspec/',
] as const

// Parses the `@reads:` header comments from a test file's first
// READS_HEADER_MAX_LINE lines. Several header lines accumulate; blank
// entries are dropped.
export function parseReadsHeader(source: string): string[] {
  const declared: string[] = []
  for (const line of source.split('\n', READS_HEADER_MAX_LINE)) {
    const match = /^\s*\/\/\s*@reads:\s*(\S.*)$/.exec(line)
    if (match === null) continue
    for (const entry of match[1].split(',')) {
      const glob = entry.trim()
      if (glob !== '') declared.push(glob)
    }
  }
  return declared
}

function normalizeRepoPath(candidate: string): string {
  return candidate.replace(/^\.\//, '')
}

// True when one declared entry covers repoPath. Entries are globs relative
// to the repository root.
export function declaresPath(declared: readonly string[], repoPath: string): boolean {
  const target = normalizeRepoPath(repoPath)
  return declared.some((entry) => new Bun.Glob(normalizeRepoPath(entry)).match(target))
}

// --- literal scanning ---

function isJoinLikeCall(call: ts.CallExpression): boolean {
  const expr = call.expression
  const name = ts.isIdentifier(expr)
    ? expr.text
    : ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : undefined
  return name === 'join' || name === 'resolve'
}

// A repository-root helper is an identifier such as repoRoot or REPO_ROOT
// that a test defines as the repository's root. Bare `root`, `repo`, or
// `project` name fixture directories just as often, so they do not count.
function isRepoRootHelper(expression: string): boolean {
  if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(expression)) return false
  const flat = expression.toLowerCase().replace(/[^a-z]/g, '')
  return /reporoot|repositoryroot|projectroot/.test(flat)
}

// A literal joined onto join()/resolve() counts only when the call's first
// argument proves the base: a repository-root helper. A tmpdir()/mkdtemp
// result or any other base holds fixture paths.
function joinedToRepoRoot(base: ts.Expression): boolean {
  const text = base.getText()
  if (/mkdtemp|tmpdir/.test(text)) return false
  return isRepoRootHelper(text)
}

function isWatchedRepoPath(candidate: string): boolean {
  return WATCHED_ROOTS.some((root) =>
    root.endsWith('/') ? candidate.startsWith(root) : candidate === root
  )
}

// Collects the watched repository paths a test file's source names, in
// source order, without duplicates.
function collectCandidates(source: ts.SourceFile): string[] {
  const found: string[] = []
  const addCandidate = (raw: string, joinedToExpression: boolean) => {
    let candidate = normalizeRepoPath(raw)
    // A template span following ${repoRoot} carries the join separator.
    if (joinedToExpression) candidate = candidate.replace(/^\/+/, '')
    if (isWatchedRepoPath(candidate) && !found.includes(candidate)) found.push(candidate)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent
      if (parent !== undefined && ts.isCallExpression(parent) && isJoinLikeCall(parent)) {
        const index = parent.arguments.indexOf(node)
        if (index > 0) {
          if (joinedToRepoRoot(parent.arguments[0])) addCandidate(node.text, false)
        } else {
          // The literal is the joined path's first segment: its own base.
          addCandidate(node.text, false)
        }
      } else {
        addCandidate(node.text, false)
      }
    } else if (ts.isTemplateExpression(node)) {
      addCandidate(node.head.text, false)
      for (const span of node.templateSpans) {
        if (joinedToRepoRoot(span.expression)) addCandidate(span.literal.text, true)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

export interface ReadsViolation {
  file: string
  path: string
}

// The watched repository paths a test file's source names but its `@reads`
// header does not declare, in source order.
export function undeclaredReads(source: string, fileName = 'test.ts'): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind
  )
  const declared = parseReadsHeader(source)
  return collectCandidates(parsed).filter((candidate) => !declaresPath(declared, candidate))
}

// Scans whole test files: one violation per undeclared literal, naming the
// file and the path.
export function scanTestSources(
  entries: readonly { file: string; content: string }[]
): ReadsViolation[] {
  const violations: ReadsViolation[] = []
  for (const { file, content } of entries) {
    for (const path of undeclaredReads(content, file)) violations.push({ file, path })
  }
  return violations
}

// The unit-test corpus the guard scans: the same four locations the suite
// runner collects (collectFiles in scripts/test-runner.ts). e2e specs are
// not part of the unit suite and are not scanned.
const UNIT_TEST_GLOBS = [
  'src/server/__tests__/*.test.ts',
  'src/client/__tests__/*.test.{ts,tsx}',
  'scripts/__tests__/*.test.{ts,tsx}',
  'src/shared/__tests__/*.test.{ts,tsx}',
] as const

export function listUnitTestFiles(root: string = process.cwd()): string[] {
  const files = new Set<string>()
  for (const pattern of UNIT_TEST_GLOBS) {
    const glob = new Bun.Glob(pattern)
    for (const file of glob.scanSync({ cwd: root, onlyFiles: true })) files.add(file)
  }
  return [...files].sort()
}



