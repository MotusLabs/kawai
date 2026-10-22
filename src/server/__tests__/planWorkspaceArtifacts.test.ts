// plan-workspace 2.1 tests: canonical change/artifact resolution over
// isolated repository fixtures with an injected CLI runner double — the
// canonical worktree rule, archive resolution and explicit ambiguity, the
// named missing and cli-unavailable states (B7), and per-kind omissions.
// Every fixture path is joined onto a fixture variable, so nothing here
// reads repository files at runtime (no @reads needed).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChangeArtifactsResolver } from '../plans/workspace/changeArtifacts'
import type { OpenspecCall, OpenspecRunner } from '../plans/validation/openspecAdapter'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-artifacts-'))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

/** One isolated fixture main checkout with its own OpenSpec tree. */
function makeMain(name: string): string {
  const main = path.join(base, name)
  fs.mkdirSync(main, { recursive: true })
  return main
}

function writeFile(root: string, relative: string, body: string): void {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

/** A change tree under `<main>/openspec/changes/<name>`; returns its root. */
function writeChange(main: string, changeName: string, files: { relative: string; body: string }[]): string {
  const changeRoot = path.join(main, 'openspec', 'changes', changeName)
  for (const file of files) writeFile(changeRoot, file.relative, file.body)
  return changeRoot
}

/** A runner double keyed by `cwd|args` — every call must match a handler. */
function stubRunner(table: Record<string, (cwd: string, args: string[]) => OpenspecCall>): {
  run: OpenspecRunner
  calls: { args: string[]; cwd: string }[]
} {
  const calls: { args: string[]; cwd: string }[] = []
  const run: OpenspecRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd })
    const handler = table[`${options.cwd}|${args.join(' ')}`]
    if (!handler) return { ok: false, exitCode: 99, stdout: '', stderr: 'unexpected call', timedOut: false }
    return handler(options.cwd, [...args])
  }
  return { run, calls }
}

const listing = (root: string, names: string[]): OpenspecCall => ({
  ok: true, exitCode: 0, timedOut: false, stderr: '',
  stdout: JSON.stringify({ changes: names.map(name => ({ name })), root: { path: root, source: 'nearest' } }),
})

const status = (changeRoot: string, kinds: Record<string, string[]>): OpenspecCall => ({
  ok: true, exitCode: 0, timedOut: false, stderr: '',
  stdout: JSON.stringify({
    changeRoot,
    artifactPaths: Object.fromEntries(Object.entries(kinds).map(([kind, files]) =>
      [kind, { existingOutputPaths: files.map(file => path.join(changeRoot, ...file.split('/'))) }])),
  }),
})

describe('ChangeArtifactsResolver', () => {
  test("a change only in main resolves to main's artifacts, nested specs included", async () => {
    const main = makeMain('main-only')
    const changeRoot = writeChange(main, 'alpha', [
      { relative: 'proposal.md', body: '# Alpha\n' },
      { relative: 'tasks.md', body: '# Tasks\n' },
      { relative: 'specs/auth/spec.md', body: '# Auth\n' },
      { relative: 'specs/auth/specs/deep.md', body: '# Deep\n' },
    ])
    const { run, calls } = stubRunner({
      [`${main}|list --json`]: cwd => listing(cwd, ['alpha']),
      [`${main}|status --change alpha --json`]: () => status(changeRoot, {
        proposal: ['proposal.md'], tasks: ['tasks.md'],
        specs: ['specs/auth/spec.md', 'specs/auth/specs/deep.md'],
      }),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('alpha', { mainRoot: main })
    expect(resolution).toMatchObject({ ok: true, changeName: 'alpha', source: { kind: 'main', root: main }, changeRoot })
    if (resolution.ok) {
      expect(resolution.artifacts).toEqual([
        { kind: 'proposal', relativePath: 'proposal.md' },
        { kind: 'tasks', relativePath: 'tasks.md' },
        { kind: 'specs', relativePath: 'specs/auth/spec.md' },
        { kind: 'specs', relativePath: 'specs/auth/specs/deep.md' },
      ])
    }
    expect(calls.map(call => `${call.cwd}|${call.args.join(' ')}`)).toEqual([
      `${main}|list --json`,
      `${main}|status --change alpha --json`,
    ])
  })

  test("a convention worktree's copy is canonical once it exists", async () => {
    const main = makeMain('convention-canonical')
    writeChange(main, 'alpha', [{ relative: 'tasks.md', body: '# main tasks\n' }])
    const convention = path.join(main, '.worktrees', 'alpha')
    const changeRoot = writeChange(convention, 'alpha', [{ relative: 'tasks.md', body: '# worktree tasks\n' }])
    const { run, calls } = stubRunner({
      [`${convention}|list --json`]: cwd => listing(cwd, ['alpha']),
      [`${convention}|status --change alpha --json`]: () => status(changeRoot, { tasks: ['tasks.md'] }),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('alpha', { mainRoot: main, worktreeRoots: [convention] })
    expect(resolution).toMatchObject({ ok: true, source: { kind: 'worktree', root: convention }, changeRoot })
    // Main is never consulted once the listed convention worktree holds the change.
    expect(calls.every(call => call.cwd === convention)).toBe(true)
  })

  test("a convention worktree lacking the change reports missing, never main's copy", async () => {
    const main = makeMain('convention-missing')
    writeChange(main, 'alpha', [{ relative: 'tasks.md', body: '# main tasks\n' }])
    const convention = path.join(main, '.worktrees', 'alpha')
    fs.mkdirSync(convention, { recursive: true })
    const { run, calls } = stubRunner({
      [`${convention}|list --json`]: cwd => listing(cwd, []),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('alpha', { mainRoot: main, worktreeRoots: [convention] })
    expect(resolution).toMatchObject({ ok: false, state: 'missing-in-worktree' })
    expect(calls.every(call => call.cwd === convention)).toBe(true)
  })

  test('an archived change resolves its unique archive location', async () => {
    const main = makeMain('archived-unique')
    const archiveRoot = path.join(main, 'openspec', 'changes', 'archive', '2026-01-02-beta')
    for (const relative of ['proposal.md', 'tasks.md', 'specs/notes/spec.md']) writeFile(archiveRoot, relative, '# archived\n')
    const { run, calls } = stubRunner({
      [`${main}|list --json`]: cwd => listing(cwd, []),
      [`${main}|list --archived --json`]: cwd => listing(cwd, ['2026-01-02-beta']),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('beta', { mainRoot: main })
    expect(resolution).toMatchObject({
      ok: true, changeName: 'beta', changeRoot: archiveRoot,
      source: { kind: 'archive', root: archiveRoot, entry: '2026-01-02-beta' },
    })
    if (resolution.ok) {
      expect(resolution.artifacts.map(artifact => artifact.relativePath)).toEqual([
        'proposal.md', 'tasks.md', 'specs/notes/spec.md',
      ])
    }
    // An archived change has no status call: artifacts come from the directory.
    expect(calls).toHaveLength(2)
  })

  test('two archive entries for one change name are an explicit ambiguity, not a pick', async () => {
    const main = makeMain('archived-ambiguous')
    for (const entry of ['2026-01-02-beta', '2026-03-04-beta']) {
      writeFile(path.join(main, 'openspec', 'changes', 'archive', entry), 'tasks.md', '# x\n')
    }
    const { run } = stubRunner({
      [`${main}|list --json`]: cwd => listing(cwd, []),
      [`${main}|list --archived --json`]: cwd => listing(cwd, ['2026-01-02-beta', '2026-03-04-beta']),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('beta', { mainRoot: main })
    expect(resolution).toMatchObject({ ok: false, state: 'ambiguous' })
  })

  test('a change absent from both listings reads missing, not an error', async () => {
    const main = makeMain('absent')
    const { run } = stubRunner({
      [`${main}|list --json`]: cwd => listing(cwd, ['alpha']),
      [`${main}|list --archived --json`]: cwd => listing(cwd, ['2026-01-02-other']),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('ghost', { mainRoot: main })
    expect(resolution).toMatchObject({ ok: false, state: 'missing' })
  })

  test('a listing CLI failure is a named state, never a throw', async () => {
    const main = makeMain('cli-failure')
    const failing: OpenspecRunner = async () => ({ ok: false, exitCode: 3, stdout: '', stderr: 'boom', timedOut: false })
    expect(await new ChangeArtifactsResolver(failing).resolve('alpha', { mainRoot: main }))
      .toMatchObject({ ok: false, state: 'cli-unavailable' })
    const unparsable: OpenspecRunner = async () => ({ ok: true, exitCode: 0, stdout: 'not json', stderr: '', timedOut: false })
    expect(await new ChangeArtifactsResolver(unparsable).resolve('alpha', { mainRoot: main }))
      .toMatchObject({ ok: false, state: 'cli-unavailable' })
  })

  test('an artifact kind with no file is an explicit missing state', async () => {
    const main = makeMain('partial-kinds')
    const changeRoot = writeChange(main, 'alpha', [
      { relative: 'proposal.md', body: '# p\n' },
      { relative: 'tasks.md', body: '# t\n' },
    ])
    const { run } = stubRunner({
      [`${main}|list --json`]: cwd => listing(cwd, ['alpha']),
      [`${main}|status --change alpha --json`]: () => status(changeRoot, {
        proposal: ['proposal.md'], tasks: ['tasks.md'], design: [],
      }),
    })
    const resolution = await new ChangeArtifactsResolver(run).resolve('alpha', { mainRoot: main })
    if (!resolution.ok) throw new Error('expected a resolution')
    // design's empty existingOutputPaths is omitted — never fabricated.
    expect(resolution.artifacts.map(artifact => artifact.kind)).toEqual(['proposal', 'tasks'])
  })
})
