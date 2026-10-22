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
// for the common forms — a literal path — and reads the source through the
// TypeScript parser, so comment mentions never count. A literal is a
// candidate when it appears on its own (tests run from the repository root,
// so a root-relative literal resolves there), is joined onto a
// repository-root helper such as `repoRoot` or onto `process.cwd()`, is
// joined onto `import.meta.dir`/`__dirname` (resolved against the test
// file's own directory), hangs from such a base through a `+`
// concatenation, or folds together consecutive literal segments of one
// join/resolve call. Literals joined onto `tmpdir()`/`mkdtemp` results or
// onto any other base are fixture paths and are ignored. A test that
// builds paths dynamically declares them by hand.

import path from 'node:path'
import ts from 'typescript'
import { UNIT_TEST_GLOBS } from '../planBatches'

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

// The base a joined or concatenated path hangs from. `repo-root` literals
// are read relative to the repository root; `file-dir` literals resolve
// against the test file's own directory (import.meta.dir or __dirname).
// A tmpdir()/mkdtemp result or any other base holds fixture paths.
type PathBase = 'repo-root' | 'file-dir'

function baseOf(expression: ts.Expression): PathBase | null {
  const text = expression.getText().trim()
  if (/mkdtemp|tmpdir/.test(text)) return null
  if (/^(?:import\.meta\.dir|__dirname)$/.test(text)) return 'file-dir'
  if (/^process\.cwd\(\)$/.test(text)) return 'repo-root'
  return isRepoRootHelper(text) ? 'repo-root' : null
}

// A file-dir base resolves the folded segments against the test file's own
// directory; a repo-root base is already root-relative (a concatenation
// carries the separator, so it is stripped).
function resolveCandidate(base: PathBase, segments: string, fileName: string): string {
  const relative = segments.replace(/^\/+/, '')
  if (base === 'repo-root') return relative
  return path.posix.normalize(path.posix.join(path.posix.dirname(fileName), relative))
}

function isWatchedRepoPath(candidate: string): boolean {
  return WATCHED_ROOTS.some((root) =>
    root.endsWith('/') ? candidate.startsWith(root) : candidate === root
  )
}

// Collects the watched repository paths a test file's source names, in
// source order, without duplicates.
function collectCandidates(source: ts.SourceFile, fileName: string): string[] {
  const found: string[] = []
  const addCandidate = (raw: string) => {
    const candidate = normalizeRepoPath(raw)
    if (isWatchedRepoPath(candidate) && !found.includes(candidate)) found.push(candidate)
  }
  // The consecutive literal arguments from `from` on fold into one path; a
  // non-literal argument ends the fold (its value is not decidable).
  // Returns the argument range the fold consumed, so the walk continues
  // through the callee and every argument around it (F5); null when the
  // base is unrecognised — those literals are fixture paths and the whole
  // call stays ignored.
  const collectJoinCall = (call: ts.CallExpression): { from: number; to: number } | null => {
    const args = call.arguments
    if (args.length === 0) return { from: 0, to: 0 }
    let base: PathBase = 'repo-root'
    let from = 0
    const first = args[0]!
    if (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first)) {
      const kind = baseOf(first)
      if (kind === null) return null
      base = kind
      from = 1
    }
    let folded: string | null = null
    let end = from
    while (end < args.length) {
      const arg = args[end]!
      if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) break
      folded = folded === null ? arg.text : `${folded}/${arg.text}`
      end += 1
    }
    if (folded === null) return { from: 0, to: 0 }
    addCandidate(resolveCandidate(base, folded, fileName))
    return { from, to: end }
  }
  const collectConcat = (left: ts.Expression, right: ts.Expression): boolean => {
    const kind = baseOf(left)
    if (kind === null) return false
    if (!ts.isStringLiteral(right) && !ts.isNoSubstitutionTemplateLiteral(right)) return false
    addCandidate(resolveCandidate(kind, right.text, fileName))
    return true
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isJoinLikeCall(node)) {
      const consumed = collectJoinCall(node)
      if (consumed === null) return
      // The fold consumed the consecutive literal arguments it joined; the
      // callee and every other argument may still hold literals (F5), so
      // the walk continues through them.
      ts.forEachChild(node.expression, visit)
      for (let index = 0; index < node.arguments.length; index++) {
        if (index >= consumed.from && index < consumed.to) continue
        visit(node.arguments[index]!)
      }
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addCandidate(node.text)
    } else if (ts.isTemplateExpression(node)) {
      addCandidate(node.head.text)
      for (const span of node.templateSpans) {
        const kind = baseOf(span.expression)
        if (kind !== null) addCandidate(resolveCandidate(kind, span.literal.text, fileName))
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (!collectConcat(node.left, node.right)) collectConcat(node.right, node.left)
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
  return collectCandidates(parsed, fileName).filter(
    (candidate) => !declaresPath(declared, candidate)
  )
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

// The unit-test corpus the guard scans is the runner's own list
// (UNIT_TEST_GLOBS in scripts/planBatches.ts, also collectFiles' source in
// scripts/test-runner.ts), so the guard scans exactly what the suite runs.
// e2e specs are not part of the unit suite and are not scanned.
export function listUnitTestFiles(root: string = process.cwd()): string[] {
  const files = new Set<string>()
  for (const pattern of UNIT_TEST_GLOBS) {
    const glob = new Bun.Glob(pattern)
    for (const file of glob.scanSync({ cwd: root, onlyFiles: true })) files.add(file)
  }
  return [...files].sort()
}