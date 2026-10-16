// The file-held validation inputs (plan-validation design D2) over temporary
// git repositories with `cleanGitEnv`: change resolution follows the change
// registry's canonical rule against fresh discovery, artifact and base-spec
// digests cover exactly what the checks read, and catalog digests cover the
// named groups and the known profile ids. The adapter is injected, and no
// test spawns a CLI process: any validate/showDeltas call would throw.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { readValidationFileInputs } from '../plans/validation/validationInputs'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

// cleanGitEnv: under the pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE,
// and a raw spawn would run these commands against the hook's repository.
function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

/** An adapter that never spawns: the probe is fixed, every CLI call throws. */
const injected = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: () => { throw new Error('no CLI process may be spawned by the inputs reader') },
  showDeltas: () => { throw new Error('no CLI process may be spawned by the inputs reader') },
}) as unknown as OpenspecAdapter

function writeChange(root: string, change: string, files: Record<string, string>) {
  const dir = path.join(root, 'openspec', 'changes', change)
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
}

let root: string
let repo: string
let convention: string
let other: string
let home: string

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-plan-validation-inputs-')))
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  git(['init', '-q', repo], root)
  // A registered change in the main checkout, with nested capability paths.
  writeChange(repo, 'main-change', {
    'proposal.md': '# Main change\n',
    'design.md': '# Design\n',
    'tasks.md': '# Tasks\n',
    'specs/team/chat/spec.md': '## ADDED Requirements\n### Requirement: X\n',
  })
  // A change registered only in the main checkout, with no convention worktree.
  writeChange(repo, 'main-only', { 'proposal.md': '# Main only\n' })
  // Its base spec exists for one capability and not the nested other.
  fs.mkdirSync(path.join(repo, 'openspec', 'specs', 'team', 'chat'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'openspec', 'specs', 'team', 'chat', 'spec.md'), '# Team chat spec\n')
  // An archived change, archived twice (a later re-archive), and a suffix
  // near-miss that must never match the change `validation`.
  writeChange(repo, 'old-change', { 'proposal.md': '# Old\n' })
  writeChange(repo, 'validation', { 'proposal.md': '# Suffix trap\n' })
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'archive'), { recursive: true })
  git(['add', 'openspec'], repo)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'changes'], repo)
  git(['mv', 'openspec/changes/old-change', 'openspec/changes/archive/2026-01-01-old-change'], repo)
  git(['mv', 'openspec/changes/validation', 'openspec/changes/archive/2026-01-01-plan-validation'], repo)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'archive'], repo)
  // A second, newer archive of old-change: the newest date resolves.
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'placeholder'], repo)
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'archive', '2026-02-02-old-change'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'openspec', 'changes', 'archive', '2026-02-02-old-change', 'proposal.md'), '# Old again\n')

  // The convention worktree for main-change, holding the same change content plus an edit.
  convention = path.join(repo, '.worktrees', 'main-change')
  git(['worktree', 'add', '-q', '-b', 'w-main-change', convention], repo)
  writeChange(convention, 'main-change', { 'proposal.md': '# Main change (worktree)\n' })
  // Another worktree holding a change the registry never saw.
  other = path.join(root, 'other-worktree')
  git(['worktree', 'add', '-q', '-b', 'w-other', other], repo)
  writeChange(other, 'lone-change', { 'proposal.md': '# Lone\n' })
  // A stray directory at a convention path that is not a listed worktree.
  writeChange(path.join(repo, '.worktrees', 'stray'), 'stray', { 'proposal.md': '# Stray\n' })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const read = (changeNames: string[], groupNames: string[] = [], branch: string | null = null) => readValidationFileInputs({
  adapter: injected(), commonDir: path.join(repo, '.git'), changeNames, groupNames, groupsRoot: repo, branch, homeDir: home,
})

describe('readValidationFileInputs (D2)', () => {
  test('a change registered only in the main checkout resolves in the main checkout', async () => {
    const inputs = await read(['main-only'])
    expect(inputs.changes[0]!.status).toBe('registered')
    expect(inputs.evidence.changes['main-only']).toEqual({ root: repo, dir: path.join(repo, 'openspec', 'changes', 'main-only'), head: expect.any(String) })
  })

  test('a change found only in the convention worktree is unregistered, naming it', async () => {
    // The convention worktree for `convention-loner` exists as a listed
    // worktree, but the main registry never listed the change.
    const worktree = path.join(repo, '.worktrees', 'convention-loner')
    git(['worktree', 'add', '-q', '-b', 'w-convention-loner', worktree], repo)
    writeChange(worktree, 'convention-loner', { 'proposal.md': '# Convention only\n' })
    const inputs = await read(['convention-loner'])
    expect(inputs.changes[0]!.status).toBe('unregistered')
    expect(inputs.evidence.changes['convention-loner']!.root).toBe(worktree)
  })

  test('a stray directory at the convention path is not a worktree and never registers', async () => {
    const inputs = await read(['stray'])
    expect(inputs.changes[0]!.status).toBe('unregistered')
    expect(inputs.evidence.changes.stray!.root).toBe(path.join(repo, '.worktrees', 'stray'))
  })

  test('the convention worktree is canonical once it exists and contains the change', async () => {
    const inputs = await read(['main-change'])
    expect(inputs.changes[0]!.status).toBe('registered')
    const artifacts = inputs.changes[0]!.artifacts
    expect(Object.keys(artifacts).sort()).toEqual(['design.md', 'proposal.md', 'specs/team/chat/spec.md', 'tasks.md'])
    // The worktree copy differs from the main checkout's: the hash follows content.
    const inMain = fs.readFileSync(path.join(repo, 'openspec', 'changes', 'main-change', 'proposal.md'))
    expect(artifacts['proposal.md']!.length).toBe(64)
    expect(artifacts['proposal.md']).not.toBe(createHash('sha256').update(inMain).digest('hex'))
    expect(inputs.evidence.changes['main-change']!.root).toBe(convention)
    expect(inputs.evidence.changes['main-change']!.head).toBeTruthy()
  })

  test('a change only in another worktree is unregistered, naming that worktree', async () => {
    const inputs = await read(['lone-change'])
    expect(inputs.changes[0]!.status).toBe('unregistered')
    expect(inputs.evidence.changes['lone-change']!.root).toBe(other)
  })

  test('an archived change resolves to its newest archive directory', async () => {
    const inputs = await read(['old-change'])
    expect(inputs.changes[0]!.status).toBe('archived')
    expect(inputs.evidence.changes['old-change']!.root).toBe(repo)
    expect(inputs.evidence.changes['old-change']!.dir).toBe(path.join(repo, 'openspec', 'changes', 'archive', '2026-02-02-old-change'))
    expect(Object.keys(inputs.changes[0]!.artifacts)).toEqual(['proposal.md'])
  })

  test('a suffix near-miss in the archive never matches: plan-validation is not the change validation', async () => {
    const inputs = await read(['validation'])
    expect(inputs.changes[0]!.status).toBe('missing')
  })

  test('a stale convention copy does not un-archive an archived change', async () => {
    writeChange(path.join(repo, '.worktrees', 'old-change'), 'old-change', { 'proposal.md': '# Stale\n' })
    const inputs = await read(['old-change'])
    expect(inputs.changes[0]!.status).toBe('archived')
    expect(inputs.evidence.changes['old-change']!.dir).toContain('2026-02-02-old-change')
  })

  test('a missing change has no digests', async () => {
    const inputs = await read(['ghost'])
    expect(inputs.changes[0]).toEqual({ change: 'ghost', status: 'missing', artifacts: {}, baseSpecs: {}, config: null })
    expect(inputs.evidence.changes.ghost).toEqual({ root: null, dir: null, head: null })
  })

  test('nested capability paths map to nested base specs; an absent base spec is null', async () => {
    writeChange(convention, 'main-change', {
      'proposal.md': '# Main change (worktree)\n',
      'specs/team/chat/spec.md': '## ADDED Requirements\n### Requirement: X\n',
      'specs/other/spec.md': '## ADDED Requirements\n### Requirement: Y\n',
    })
    const inputs = await read(['main-change'])
    expect(inputs.changes[0]!.baseSpecs['team/chat']).toBeTruthy()
    expect(inputs.changes[0]!.baseSpecs.other).toBeNull()
  })

  test('a known group hashes its definition; an unknown group is null; profiles hash the known ids', async () => {
    fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'middle-devs.md'), '# Middle Dev\n\nBody text.\n')
    const first = await read(['main-change'], ['middle-devs', 'ghosts'])
    expect(first.catalog.groups['middle-devs']).toBeTruthy()
    expect(first.catalog.groups.ghosts).toBeNull()
    // Editing the group's parsed definition changes its digest.
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'middle-devs.md'), '# Middle Dev\n\nLonger body.\n')
    const second = await read(['main-change'], ['middle-devs'])
    expect(second.catalog.groups['middle-devs']).not.toBe(first.catalog.groups['middle-devs'])
  })

  test('the adapter probe feeds the inputs and no CLI process is spawned', async () => {
    const inputs = await read(['main-change'])
    expect(inputs.adapter).toEqual({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'] })
  })

  test('a moved proposal with unchanged content keeps identical digests', async () => {
    const files = { 'proposal.md': '# Twin\n', 'specs/chat/spec.md': '## ADDED Requirements\n### Requirement: T\n' }
    writeChange(repo, 'twin', files)
    const worktree = path.join(repo, '.worktrees', 'twin')
    git(['worktree', 'add', '-q', '-b', 'w-twin', worktree], repo)
    writeChange(worktree, 'twin', files)
    const fromWorktree = await read(['twin'])
    expect(fromWorktree.evidence.changes.twin!.root).toBe(worktree)
    git(['worktree', 'remove', '--force', worktree], repo)
    const fromMain = await read(['twin'])
    expect(fromMain.evidence.changes.twin!.root).toBe(repo)
    // Identical content: the digests — and so the identity — did not move.
    expect(fromMain.changes[0]).toEqual(fromWorktree.changes[0])
  })

  test('a symlinked spec is skipped, never followed or hashed', async () => {
    const changeDir = path.join(repo, 'openspec', 'changes', 'main-change')
    const specs = path.join(changeDir, 'specs', 'extra')
    fs.mkdirSync(specs, { recursive: true })
    fs.symlinkSync(path.join(changeDir, 'proposal.md'), path.join(specs, 'spec.md'))
    const inputs = await read(['main-change'])
    expect(Object.keys(inputs.changes[0]!.artifacts)).not.toContain('specs/extra/spec.md')
    expect(inputs.changes[0]!.baseSpecs.extra).toBeUndefined()
  })
})
