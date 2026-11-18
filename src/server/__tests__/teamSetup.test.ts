// @reads: config/groups/**
// Set up team (starter-team-setup D1–D3): Table S (the write's outcomes),
// Table O (when setup is offered), P2 (pre-existing files are never changed
// and nothing lands outside the groups directory), and the templates parsing
// clean against the shipped catalogs — all over private /tmp roots.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadGroupCatalog } from '../team/groupCatalog'
import { projectGroupFiles, runTeamSetup, setupAvailable, setupPreview, STARTER_TEMPLATES } from '../team/teamSetup'
import { propertyCases } from './helpers/propertyCases'

const CONFIG = path.resolve(import.meta.dir, '../../../config/groups')
let root: string
let home: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-team-setup-')))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
  fs.mkdirSync(home)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const repo = () => path.join(root, 'repo')
const groupsDir = () => path.join(repo(), '.kawai', 'groups')
const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const STARTER = ['devs.md', 'lead.md', 'reviewers.md']

describe('Table S — the setup write', () => {
  // @covers: team-setup › Confirming writes the starter group files › Written files equal the templates
  test('S1: a checkout with no .kawai gets the three files, byte-equal to config/groups', () => {
    expect(runTeamSetup(repo())).toEqual({ ok: true, created: ['lead.md', 'devs.md', 'reviewers.md'], skipped: [] })
    expect(listing(groupsDir())).toEqual(STARTER)
    for (const name of STARTER) {
      expect(fs.readFileSync(path.join(groupsDir(), name), 'utf8')).toBe(fs.readFileSync(path.join(CONFIG, name), 'utf8'))
    }
  })

  test('S2: a groups directory holding only non-.md files is set up, the other file untouched', () => {
    fs.mkdirSync(groupsDir(), { recursive: true })
    fs.writeFileSync(path.join(groupsDir(), 'README.txt'), 'notes')
    expect(runTeamSetup(repo()).ok).toBe(true)
    expect(listing(groupsDir())).toEqual(['README.txt', ...STARTER])
    expect(fs.readFileSync(path.join(groupsDir(), 'README.txt'), 'utf8')).toBe('notes')
  })

  // @covers: team-setup › Setup never overwrites a group file › A file added after the preview refuses the setup
  test('S3: any .md group file, valid or not, refuses the whole setup and writes nothing', () => {
    fs.mkdirSync(groupsDir(), { recursive: true })
    fs.writeFileSync(path.join(groupsDir(), 'devs.md'), '---\nmax: nope\n---\n')
    expect(runTeamSetup(repo())).toEqual({
      ok: false, reason: 'already-set-up', created: [], skipped: [],
      error: 'The team already has group files: devs.md. Set up team never overwrites them.',
    })
    expect(listing(groupsDir())).toEqual(['devs.md'])
    expect(fs.readFileSync(path.join(groupsDir(), 'devs.md'), 'utf8')).toBe('---\nmax: nope\n---\n')
  })

  // @covers: team-setup › Setup never overwrites a group file › A symlinked groups directory is refused
  test('S4/S5: a symlinked .kawai or groups directory is refused, nothing written through it', () => {
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(repo(), '.kawai'))
    expect(runTeamSetup(repo())).toMatchObject({ ok: false, reason: 'symlink', created: [], skipped: [] })
    expect(listing(elsewhere)).toEqual([])
    fs.rmSync(path.join(repo(), '.kawai'))
    fs.mkdirSync(path.join(repo(), '.kawai'))
    fs.symlinkSync(elsewhere, groupsDir())
    const refused = runTeamSetup(repo())
    expect(refused).toMatchObject({ ok: false, reason: 'symlink', created: [], skipped: [] })
    expect(refused.error).toContain(groupsDir())
    expect(listing(elsewhere)).toEqual([])
  })

  // @covers: team-setup › Setup never overwrites a group file › A racing file is kept
  test('S6: a file created between the check and its link is kept and reported skipped', () => {
    const result = runTeamSetup(repo(), {
      beforeLink: (id, target) => { if (id === 'reviewers') fs.writeFileSync(target, 'someone else') },
    })
    expect(result).toEqual({ ok: true, created: ['lead.md', 'devs.md'], skipped: ['reviewers.md'] })
    expect(fs.readFileSync(path.join(groupsDir(), 'reviewers.md'), 'utf8')).toBe('someone else')
    expect(listing(groupsDir())).toEqual(STARTER)
  })

  // The temp file is opened exclusively: a link planted at its name is never
  // written through, so the bytes cannot land outside the groups directory.
  test('S6b: a symbolic link planted at a temp name is refused, its target untouched', () => {
    const outside = path.join(root, 'outside.txt')
    fs.writeFileSync(outside, 'keep')
    fs.mkdirSync(groupsDir(), { recursive: true })
    fs.symlinkSync(outside, path.join(groupsDir(), '.lead.md.fixed.tmp'))
    const result = runTeamSetup(repo(), { tempSuffix: () => 'fixed' })
    expect(result).toMatchObject({ ok: false, reason: 'error', created: [], skipped: [] })
    expect(result.error).toStartWith('Writing lead.md failed: ')
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
    expect(listing(groupsDir()).filter(name => name.endsWith('.md'))).toEqual([])
  })

  // @covers: team-setup › Setup never overwrites a group file › An unwritable directory is reported
  test('S7: a write error stops, names the files created, and leaves no partial or temp file', () => {
    const result = runTeamSetup(repo(), {
      beforeLink: id => { if (id === 'devs') throw new Error('disk full') },
    })
    expect(result).toEqual({ ok: false, reason: 'error', error: 'Writing devs.md failed: disk full', created: ['lead.md'], skipped: [] })
    expect(listing(groupsDir())).toEqual(['lead.md'])
  })

  test('S7b: an unwritable .kawai is reported, nothing created', () => {
    if (process.getuid?.() === 0) return
    fs.mkdirSync(path.join(repo(), '.kawai'))
    fs.chmodSync(path.join(repo(), '.kawai'), 0o555)
    try {
      const result = runTeamSetup(repo())
      expect(result).toMatchObject({ ok: false, reason: 'error', created: [], skipped: [] })
    } finally {
      fs.chmodSync(path.join(repo(), '.kawai'), 0o755)
    }
  })
})

describe('Table O — when setup is offered', () => {
  test('O1: no groups directory → available', () => expect(setupAvailable(repo())).toBe(true))

  test('O2: only non-.md files → available', () => {
    fs.mkdirSync(groupsDir(), { recursive: true })
    fs.writeFileSync(path.join(groupsDir(), 'notes.txt'), 'x')
    expect(setupAvailable(repo())).toBe(true)
  })

  // @covers: team-setup › The setup action is offered to a team without project groups › Any project group file hides the action
  test('O3: any .md, even one that fails to parse → not available', () => {
    fs.mkdirSync(groupsDir(), { recursive: true })
    fs.writeFileSync(path.join(groupsDir(), 'notes.md'), '---\nunclosed')
    expect(setupAvailable(repo())).toBe(false)
    expect(projectGroupFiles(repo())).toEqual(['notes.md'])
  })

  // @covers: team-setup › The setup action is offered to a team without project groups › User-level groups do not hide the action
  test('O4: user-level groups alone do not count', () => {
    fs.mkdirSync(path.join(home, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'reviewers-sol.md'), 'Review.')
    expect(setupAvailable(repo())).toBe(true)
  })
})

describe('the preview and the templates', () => {
  // @covers: team-setup › The setup previews the starter team before writing › The preview lists the three groups
  test('the preview lists the three groups with workers, caps, and the cross-model flag', () => {
    const preview = setupPreview(repo(), new Set(['opus', 'codex-sol']))
    expect(preview).toEqual({
      available: true, targetDir: groupsDir(), warnings: [],
      groups: [
        expect.objectContaining({ id: 'lead', label: 'Team Lead', workers: [{ profileId: 'codex-sol', cap: 1 }], max: 1, crossModelReview: false }),
        expect.objectContaining({ id: 'devs', label: 'Dev', workers: [{ profileId: 'opus', cap: 1 }, { profileId: 'codex-sol', cap: 1 }], max: 2, crossModelReview: false }),
        expect.objectContaining({ id: 'reviewers', label: 'Reviewers', workers: [{ profileId: 'codex-sol', cap: 1 }, { profileId: 'opus', cap: 1 }], max: 2, crossModelReview: true }),
      ],
    })
  })

  // @covers: team-setup › The setup previews the starter team before writing › A missing worker profile is warned
  test('a starter worker the catalog lacks is warned once', () => {
    expect(setupPreview(repo(), new Set(['opus'])).warnings).toEqual([
      "Profile codex-sol is not defined in this team's catalog; its slots will not staff until it is.",
    ])
  })

  // @covers: team-setup › The starter templates define a working team › Templates parse clean
  test('the written templates load with no error or warning against the shipped catalogs', () => {
    expect(runTeamSetup(repo()).ok).toBe(true)
    const catalog = loadGroupCatalog({ groupsRoot: repo(), homeDir: home })
    expect(catalog.errors).toEqual([])
    expect(catalog.warnings).toEqual([])
    expect([...catalog.groups.keys()]).toEqual(['devs', 'lead', 'reviewers'])
    const lead = catalog.groups.get('lead')!.group
    expect({ canCreateTasks: lead.canCreateTasks, canCreatePlans: lead.canCreatePlans, max: lead.max, workers: lead.profiles }).toEqual({
      canCreateTasks: true, canCreatePlans: true, max: 1, workers: [{ profileId: 'codex-sol', cap: 1 }],
    })
    expect(catalog.groups.get('devs')!.group.profiles).toEqual([{ profileId: 'opus', cap: 1 }, { profileId: 'codex-sol', cap: 1 }])
  })

  // @covers: team-setup › The starter templates define a working team › Reviewers require cross-model review
  test('the reviewers template turns cross-model review on', () => {
    expect(runTeamSetup(repo()).ok).toBe(true)
    const reviewers = loadGroupCatalog({ groupsRoot: repo(), homeDir: home }).groups.get('reviewers')!.group
    expect(reviewers.crossModelReview).toBe(true)
    expect(reviewers.profiles).toEqual([{ profileId: 'codex-sol', cap: 1 }, { profileId: 'opus', cap: 1 }])
  })

  test('the embedded templates are the config/groups files', () => {
    for (const { id, text } of STARTER_TEMPLATES) expect(text).toBe(fs.readFileSync(path.join(CONFIG, `${id}.md`), 'utf8'))
  })
})

/** A seeded linear congruential stream (no dependency): values in [0, 1). */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** Every file under a directory (symlinks not followed), with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of fs.existsSync(at) ? fs.readdirSync(at) : []) {
      const full = path.join(at, name)
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) out[path.relative(root, full)] = `-> ${fs.readlinkSync(full)}`
      else if (stat.isDirectory()) walk(full)
      else out[path.relative(root, full)] = fs.readFileSync(full, 'latin1')
    }
  }
  walk(dir)
  return out
}

describe('P2 — the write never changes what exists and stays inside the groups directory', () => {
  test('P2: seeded pre-existing contents (seed 0x5eed02, 200 cases)', () => {
    const next = stream(0x5eed02)
    const NAMES = ['lead.md', 'devs.md', 'notes.md', 'README.txt', 'reviewers.md.bak', '.hidden']
    for (let i = 0; i < propertyCases(200); i++) {
      fs.rmSync(path.join(root, 'repo'), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'outside'), { recursive: true, force: true })
      fs.mkdirSync(path.join(root, 'outside'), { recursive: true })
      fs.writeFileSync(path.join(root, 'outside', 'keep.md'), 'outside')
      fs.mkdirSync(repo(), { recursive: true })
      const shape = next()
      if (shape < 0.15) fs.symlinkSync(path.join(root, 'outside'), path.join(repo(), '.kawai'))
      else if (shape < 0.3) {
        fs.mkdirSync(path.join(repo(), '.kawai'))
        fs.symlinkSync(path.join(root, 'outside'), groupsDir())
      } else if (shape < 0.85) {
        fs.mkdirSync(groupsDir(), { recursive: true })
        for (let f = 0; f < Math.floor(next() * 4); f++) {
          const name = NAMES[Math.floor(next() * NAMES.length)]!
          fs.writeFileSync(path.join(groupsDir(), name), String.fromCharCode(...Array.from({ length: 1 + Math.floor(next() * 8) }, () => Math.floor(next() * 256))))
        }
      }
      const before = snapshot(root)
      const result = runTeamSetup(repo())
      const after = snapshot(root)
      for (const [file, bytes] of Object.entries(before)) expect(after[file]).toBe(bytes)
      const added = Object.keys(after).filter(file => !(file in before))
      for (const file of added) expect(path.dirname(path.join(root, file))).toBe(groupsDir())
      expect(added.map(file => path.basename(file)).sort()).toEqual([...result.created].sort())
    }
  })
})

// Root-swap races (integration R4/R5): once runTeamSetup has verified the
// directory chain, a concurrent rename + outside symlink at any level — the
// Lead probe class (/tmp/pr437-root-swap-probe.ts) — must never redirect a
// write: every byte stays inside the project and the run refuses to report
// success through a path it no longer occupies. The swap is planted at the
// first beforeLink, exactly where the old one-shot lstat checks had expired.
describe('root-swap races — the write stays inside the verified directory', () => {
  let swapped = false
  const swapAt = (live: string, outside: string) => () => {
    if (swapped) return
    swapped = true
    fs.renameSync(live, `${live}.original`)
    fs.symlinkSync(outside, live, 'dir')
  }
  beforeEach(() => { swapped = false })

  test('a groups-directory swap mid-run keeps every byte in the project and refuses', () => {
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    const result = runTeamSetup(repo(), { beforeLink: swapAt(groupsDir(), outside) })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('error')
    expect(fs.readdirSync(outside)).toEqual([])
    // Whatever the pinned run wrote stayed in the renamed in-project directory.
    const displaced = path.join(repo(), '.kawai', 'groups.original')
    expect(fs.readdirSync(displaced).filter(name => name.endsWith('.md')).sort()).toEqual(STARTER)
  })

  test('a .kawai swap mid-run keeps every byte in the project and refuses', () => {
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    const result = runTeamSetup(repo(), { beforeLink: swapAt(path.join(repo(), '.kawai'), outside) })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('error')
    expect(fs.readdirSync(outside)).toEqual([])
    const displaced = path.join(repo(), '.kawai.original', 'groups')
    expect(fs.readdirSync(displaced).filter(name => name.endsWith('.md')).sort()).toEqual(STARTER)
  })

  test('a project-root swap mid-run keeps every byte in the project and refuses', () => {
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    const result = runTeamSetup(repo(), { beforeLink: swapAt(repo(), outside) })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('error')
    expect(fs.readdirSync(outside)).toEqual([])
    const displaced = path.join(root, 'repo.original', '.kawai', 'groups')
    expect(fs.readdirSync(displaced).filter(name => name.endsWith('.md')).sort()).toEqual(STARTER)
  })

  test('the pinned run closes every descriptor it opened (success and refusal)', () => {
    if (process.platform !== 'linux') return // descriptor pinning runs natively on Linux; Darwin is typecheck-only (integration R5)
    const openFds = () => fs.readdirSync('/proc/self/fd').length
    const before = openFds()
    expect(runTeamSetup(repo()).ok).toBe(true)
    expect(openFds()).toBe(before)
    fs.rmSync(groupsDir(), { recursive: true })
    fs.symlinkSync(path.join(root, 'home'), groupsDir())
    expect(runTeamSetup(repo()).ok).toBe(false)
    expect(openFds()).toBe(before)
  })
})
