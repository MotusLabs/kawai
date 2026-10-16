// Repository facts (execution-safety-recovery D4) over hand-built git
// layouts in a temporary directory — no `git` process, only the text files
// the resolver reads. Reserved example names throughout.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RepoFactsResolver } from '../outbound/repoFacts'

const CONFIG = `
[remote "origin"]
	url = https://github.com/acme/kawai.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[remote "fork"]
	url = https://github.com/other/kawai.git
	pushurl = https://github.com/other/kawai-push.git
[submodule "vendor/lib"]
	url = https://github.com/acme/vendor-lib.git
[branch "main"]
	remote = origin
	merge = refs/heads/main
[branch "topic"]
	remote = fork
`

describe('RepoFactsResolver', () => {
  let root: string
  let main: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-repofacts-')))
    main = path.join(root, 'main')
    fs.mkdirSync(path.join(main, '.git'), { recursive: true })
    fs.writeFileSync(path.join(main, '.git', 'config'), CONFIG)
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test('main repository: root, team id, remotes, and the branch push remote', () => {
    const resolver = new RepoFactsResolver()
    const facts = resolver.factsFor(path.join(main, 'src'))
    expect(facts).toMatchObject({
      root: main,
      teamId: path.join(main, '.git'),
      originUrls: ['https://github.com/acme/kawai.git'],
      pushRemote: 'origin',
    })
    // A push target prefers the remote's pushurl over its url.
    expect(facts?.remotes.get('fork')).toEqual(['https://github.com/other/kawai-push.git'])
    // A [submodule] header closed the fork section: its url never overwrote it.
    expect(facts?.remotes.get('fork')?.[0]).not.toBe('https://github.com/acme/vendor-lib.git')
    expect([...facts!.remotes.keys()].sort()).toEqual(['fork', 'origin'])
  })

  test('a linked worktree shares the parsed config but keeps its own root and HEAD', () => {
    const worktree = path.join(root, 'wt')
    const headDir = path.join(main, '.git', 'worktrees', 'wt')
    fs.mkdirSync(path.join(worktree), { recursive: true })
    fs.mkdirSync(headDir, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${headDir}\n`)
    // The worktree is on `topic`, whose push remote is fork.
    fs.writeFileSync(path.join(headDir, 'HEAD'), 'ref: refs/heads/topic\n')
    const resolver = new RepoFactsResolver()
    const mainFacts = resolver.factsFor(main)
    const wtFacts = resolver.factsFor(worktree)
    // The config parse is cached once, shared — but each keeps its root.
    expect(wtFacts?.root).toBe(worktree)
    expect(wtFacts?.teamId).toBe(path.join(main, '.git'))
    expect(wtFacts?.remotes).toEqual(mainFacts?.remotes)
    expect(wtFacts?.originUrls).toEqual(['https://github.com/acme/kawai.git'])
    // main pushes to origin (its branch remote); topic pushes to fork.
    expect(mainFacts?.pushRemote).toBe('origin')
    expect(wtFacts?.pushRemote).toBe('fork')
  })

  test('a branch switch re-reads HEAD under an unchanged config stamp', () => {
    const resolver = new RepoFactsResolver()
    expect(resolver.factsFor(main)?.pushRemote).toBe('origin')
    // Same config file, same stamp: only HEAD moved.
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/topic\n')
    const after = resolver.factsFor(main)
    expect(after?.pushRemote).toBe('fork')
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(resolver.factsFor(main)?.pushRemote).toBe('origin')
  })

  test('a config edit re-parses under a new stamp', () => {
    const resolver = new RepoFactsResolver()
    expect(resolver.factsFor(main)?.remotes.get('origin')).toEqual(['https://github.com/acme/kawai.git'])
    const edited = CONFIG.replace('acme/kawai.git', 'acme/kawai2.git')
    fs.writeFileSync(path.join(main, '.git', 'config'), edited)
    expect(resolver.factsFor(main)?.originUrls).toEqual(['https://github.com/acme/kawai2.git'])
  })

  test('a relative gitdir resolves against the .git file\'s directory', () => {
    const worktree = path.join(root, 'wt')
    const headDir = path.join(main, '.git', 'worktrees', 'wt')
    fs.mkdirSync(worktree, { recursive: true })
    fs.mkdirSync(headDir, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
    fs.writeFileSync(path.join(headDir, 'HEAD'), 'ref: refs/heads/main\n')
    const facts = new RepoFactsResolver().factsFor(worktree)
    expect(facts?.root).toBe(worktree)
    expect(facts?.teamId).toBe(path.join(main, '.git'))
  })

  test('an unreadable .git file or a missing config reads unreadable, never throws', () => {
    const broken = path.join(root, 'broken')
    fs.mkdirSync(broken)
    fs.writeFileSync(path.join(broken, '.git'), 'not a gitdir pointer')
    const resolver = new RepoFactsResolver()
    expect(resolver.factsFor(broken)).toBe(null)
    // A .git directory with no config at all reads unreadable facts.
    const empty = path.join(root, 'empty')
    fs.mkdirSync(path.join(empty, '.git'), { recursive: true })
    fs.writeFileSync(path.join(empty, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const facts = resolver.factsFor(empty)
    expect(facts).toMatchObject({ unreadable: true, originUrls: [], root: empty })
    expect(facts?.remotes.size).toBe(0)
    // No repository above the temp root.
    expect(resolver.factsFor(path.join(root, 'nowhere'))).toBe(null)
  })
})

describe('RepoFactsResolver: push remote chain and config pinning (CC round 4 C)', () => {
  let root: string
  let main: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-repofacts-c-')))
    main = path.join(root, 'main')
    fs.mkdirSync(path.join(main, '.git'), { recursive: true })
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const writeConfig = (config: string): void => {
    fs.writeFileSync(path.join(main, '.git', 'config'), config)
  }
  const BASE = '[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n'

  test('the push remote chain: branch pushRemote > pushDefault > branch remote > origin', () => {
    const resolver = new RepoFactsResolver()
    // No branch section at all: origin.
    writeConfig(BASE)
    expect(resolver.factsFor(main)?.pushRemote).toBe('origin')
    // remote.pushDefault beats branch.remote.
    writeConfig(`${BASE}[remote "exfil"]\n\turl = https://github.com/evil/x.git\n[remote]\n\tpushDefault = exfil\n[branch "main"]\n\tremote = origin\n`)
    expect(resolver.factsFor(main)?.pushRemote).toBe('exfil')
    // branch.pushRemote beats them both.
    writeConfig(`${BASE}[remote "fork"]\n\turl = https://github.com/other/fork.git\n[remote]\n\tpushDefault = exfil\n[branch "main"]\n\tremote = origin\n\tpushRemote = fork\n`)
    expect(resolver.factsFor(main)?.pushRemote).toBe('fork')
  })

  test('a remote with several url lines keeps them all; pushurl replaces them', () => {
    const resolver = new RepoFactsResolver()
    writeConfig(`${BASE}[remote "fork"]\n\turl = https://github.com/other/fork.git\n\turl = https://git.example.internal/kawai.git\n`)
    expect(resolver.factsFor(main)?.remotes.get('fork')).toEqual([
      'https://github.com/other/fork.git', 'https://git.example.internal/kawai.git',
    ])
    writeConfig(`${BASE}[remote "fork"]\n\turl = https://github.com/other/fork.git\n\tpushurl = https://github.com/other/push.git\n\turl = https://git.example.internal/kawai.git\n`)
    expect(resolver.factsFor(main)?.remotes.get('fork')).toEqual(['https://github.com/other/push.git'])
  })

  test('include, insteadOf, and unreadable headers pin the facts', () => {
    const resolver = new RepoFactsResolver()
    writeConfig(`${BASE}[include]\n\tpath = ../extra.config\n`)
    expect(resolver.factsFor(main)?.pinned).toContain('include')
    writeConfig(`${BASE}[url "https://github.com/"]\n\tinsteadOf = https://git.example.internal/\n`)
    expect(resolver.factsFor(main)?.pinned).toContain('insteadOf')
    writeConfig(`${BASE}[remote "broken\n`)
    expect(resolver.factsFor(main)?.pinned).toContain('header was not understood')
    // A clean config again has no pin.
    writeConfig(BASE)
    expect(resolver.factsFor(main)?.pinned).toBeUndefined()
  })

  test('lenient headers, trailing comments, CRLF, and duplicate sections read exactly', () => {
    const resolver = new RepoFactsResolver()
    // Dotted form, a quoted header with a comment, a capitalized section
    // word, CRLF line ends, and a quoted value.
    writeConfig('[remote "origin"] # primary\r\n\turl = "https://github.com/acme/kawai.git"\r\n[Remote.fork]\r\n\turl = https://github.com/other/fork.git\r\n')
    const facts = resolver.factsFor(main)
    expect(facts?.originUrls).toEqual(['https://github.com/acme/kawai.git'])
    expect(facts?.remotes.get('fork')).toEqual(['https://github.com/other/fork.git'])
    expect(facts?.pinned).toBeUndefined()
    // A later duplicate section with only fetch keeps origin's url.
    writeConfig(`${BASE}[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
    expect(resolver.factsFor(main)?.originUrls).toEqual(['https://github.com/acme/kawai.git'])
  })

  test('the section reset survives with a url-only remote (CC mutation gap)', () => {
    // fork carries NO pushurl: if a later [submodule] header failed to close
    // the fork section, its url would be overwritten by the submodule's.
    const resolver = new RepoFactsResolver()
    writeConfig(`${BASE}[remote "fork"]\n\turl = https://github.com/other/fork.git\n[submodule "vendor/lib"]\n\turl = https://github.com/acme/vendor-lib.git\n`)
    expect(resolver.factsFor(main)?.remotes.get('fork')).toEqual(['https://github.com/other/fork.git'])
  })

  test('git booleans, comments, and quoted subsection case (round 6 B4, L1)', () => {
    const resolver = new RepoFactsResolver()
    // Every git boolean form, and the bare key, pins.
    for (const value of [' = true', ' = 1', ' = yes', ' = on', '']) {
      writeConfig(`[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n[extensions]\n\tworktreeConfig${value}\n`)
      expect(resolver.factsFor(main)?.pinned).toBe('worktree config is not read')
    }
    // A ; comment ends at the newline: the backslash inside it continues
    // nothing, and the pushurl on the next line stays a push target.
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.git ; c \\\n\tpushurl = https://github.com/other/fork.git\n')
    const facts = resolver.factsFor(main)
    expect(facts?.pinned).toBeUndefined()
    expect(facts?.remotes.get('origin')).toEqual(['https://github.com/other/fork.git'])
    // A quoted subsection keeps its case: [branch "Main"] never hijacks main.
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n[branch "Main"]\n\tremote = fork\n[remote.fork]\n\turl = https://github.com/other/fork.git\n')
    expect(resolver.factsFor(main)?.pushRemote).toBe('origin')
  })

  test('insteadOf pins explicit URLs, legacy subsections lowercase, continuations fold, worktreeConfig pins (round 5 R4)', () => {
    const resolver = new RepoFactsResolver()
    // [branch.Main] and [remote.ORIGIN] (any case) resolve like lowercase.
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n[remote.ORIGIN2]\n\turl = https://github.com/other/x.git\n[branch.Main]\n\tremote = origin\n')
    const facts = resolver.factsFor(main)
    expect(facts?.pushRemote).toBe('origin')
    expect(facts?.pinned).toBeUndefined()
    // insteadOf pins every push, explicit URLs included (classify covers that
    // via RepoFacts.pinned); a folded value line reads as one value.
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n[url "https://github.com/"]\n\tinsteadOf = https://git.example.internal/\n')
    expect(resolver.factsFor(main)?.pinned).toContain('insteadOf')
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.\\\n\tgit\n')
    expect(resolver.factsFor(main)?.originUrls).toEqual(['https://github.com/acme/kawai.git'])
    // extensions.worktreeConfig=true pins: the per-worktree file is unread.
    writeConfig('[remote "origin"]\n\turl = https://github.com/acme/kawai.git\n[extensions]\n\tworktreeConfig = true\n')
    expect(resolver.factsFor(main)?.pinned).toBe('worktree config is not read')
  })
})
