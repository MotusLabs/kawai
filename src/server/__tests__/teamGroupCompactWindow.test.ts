// @reads: config/profiles.default.json, config/providers.default.json
// Role compaction windows (mimo-million-token-context D2/D3): rows G1-G4
// over real group files, parsed by groupFile, resolved by groupCatalog
// against the shipped profile catalog, and read per spawn through
// SessionTeams.compactWindowFor; row V1 through the read-only member rows.
// (A focused file: teamGroupFile.test.ts sits at the 500-line limit.)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadGroupCatalog } from '../team/groupCatalog'
import { parseGroupFile } from '../team/groupFile'
import { SessionTeams } from '../team/sessionTeams'
import { memberRows } from '../team/workspaceRead'

let root: string
let repo: string
let home: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-group-window-')))
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const writeRole = (frontmatter: string) =>
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), `---\n${frontmatter}\n---\nBuild.`)

/** The role as the catalog holds it, and the window each profile's member resolves. */
async function resolveRole(frontmatter: string, profiles: string[]) {
  writeRole(frontmatter)
  const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
  const entry = catalog.groups.get('devs')
  const teams = new SessionTeams({ homeDir: home })
  await teams.track('s1', repo)
  const windows = Object.fromEntries(profiles.map(profile => [profile, teams.compactWindowFor('s1', 'devs', profile)]))
  return { group: entry?.group, errors: catalog.errors, windows }
}

describe('row G1: an invalid default or a malformed map', () => {
  // @covers: agent-teams › Invalid role compaction preferences are warned and ignored › Malformed override map
  test('G1 keeps the group, warns and ignores the field, and the valid fallback applies', async () => {
    for (const raw of ['99999', '1000001', '3e5', '300_000', 'abc', '250000.5']) {
      const { group, errors, windows } = await resolveRole(`autoCompactWindow: ${raw}\nprofileAutoCompactWindow: { mimo: 300000 }`, ['mimo', 'kimi'])
      expect(errors, raw).toEqual([])
      expect(group?.prompt, raw).toBe('Build.')
      expect(group?.autoCompactWindow, raw).toBeUndefined()
      expect(group?.warnings, raw).toContain(`autoCompactWindow must be an integer from 100000 to 1000000, got "${raw}"; ignored`)
      // The catalog fallback decides for kimi; mimo's own entry still applies.
      expect(windows, raw).toEqual({ mimo: 300000, kimi: undefined })
    }
    for (const raw of ['[mimo, kimi]', '{ mimo: { a: 1 } }', '{ mimo: 300000', 'mimo: 300000']) {
      const { group, errors, windows } = await resolveRole(`autoCompactWindow: 250000\nprofileAutoCompactWindow: ${raw}`, ['mimo'])
      expect(errors, raw).toEqual([])
      expect(group?.profileAutoCompactWindow, raw).toBeUndefined()
      expect(group?.warnings.some(warning => warning.startsWith('profileAutoCompactWindow: ') && warning.endsWith('; ignored')), raw).toBe(true)
      expect(windows, raw).toEqual({ mimo: 250000 })
    }
  })
})

describe('row G2: a bad entry beside a valid sibling', () => {
  // @covers: agent-teams › Invalid role compaction preferences are warned and ignored › Invalid size retains valid siblings
  test('G2 an invalid, unknown or wrong-qualified entry is warned alone and its sibling applies', async () => {
    const invalid = await resolveRole('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 99999, sonnet: 400000 }', ['mimo', 'sonnet'])
    expect(invalid.group?.warnings).toContain('profileAutoCompactWindow.mimo must be an integer from 100000 to 1000000, got "99999"; ignored')
    expect(invalid.windows).toEqual({ mimo: 250000, sonnet: 400000 })
    const unknown = await resolveRole('profileAutoCompactWindow: { nope: 300000, sonnet: 400000 }', ['nope', 'sonnet'])
    expect(unknown.group?.warnings).toContain('profileAutoCompactWindow: "nope" is not defined; ignored')
    expect(unknown.group?.profileAutoCompactWindow).toEqual({ sonnet: 400000 })
    expect(unknown.windows).toEqual({ nope: undefined, sonnet: 400000 })
    const qualified = await resolveRole('profileAutoCompactWindow: { zai/mimo: 300000, sonnet: 400000 }', ['mimo', 'sonnet'])
    expect(qualified.group?.warnings).toContain('profileAutoCompactWindow: "zai/mimo" is not defined; ignored')
    expect(qualified.windows).toEqual({ mimo: undefined, sonnet: 400000 })
  })
})

describe('row G3: repeated and aliased keys', () => {
  // @covers: agent-teams › Invalid role compaction preferences are warned and ignored › Duplicate keys
  // @covers: agent-teams › Roles can choose an auto-compaction window › Qualified model key
  test('G3 two valid keys resolving to one profile: the first written wins and the later is warned', async () => {
    const aliased = await resolveRole('profileAutoCompactWindow: { mimo: 300000, mimo/mimo: 400000 }', ['mimo'])
    expect(aliased.windows).toEqual({ mimo: 300000 })
    expect(aliased.group?.warnings).toContain('profileAutoCompactWindow: "mimo/mimo" is already listed; the later entry is ignored')
    const qualifiedFirst = await resolveRole('profileAutoCompactWindow: { mimo/mimo: 400000, mimo: 300000 }', ['mimo'])
    expect(qualifiedFirst.windows).toEqual({ mimo: 400000 })
    expect(qualifiedFirst.group?.warnings).toContain('profileAutoCompactWindow: "mimo" is already listed; the later entry is ignored')
  })

  // @covers: agent-teams › Invalid role compaction preferences are warned and ignored › Invalid written key before a valid alias
  test('G3 a repeated written key is consumed by its first occurrence even when invalid; a later valid alias supplies the value', async () => {
    const repeated = await resolveRole('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 99999, mimo: 300000 }', ['mimo'])
    expect(repeated.group?.warnings).toContain('profileAutoCompactWindow: "mimo" is listed twice; the later entry is ignored')
    expect(repeated.windows).toEqual({ mimo: 250000 })
    const alias = await resolveRole('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 99999, mimo/mimo: 400000 }', ['mimo'])
    expect(alias.windows).toEqual({ mimo: 400000 })
  })
})

describe('row G4: known profiles the role does not list', () => {
  // @covers: agent-teams › Invalid role compaction preferences are warned and ignored › Unknown and unlisted models
  test('G4 a known unlisted profile, bare and qualified, is warned and still applies to a member on it', async () => {
    const { group, windows } = await resolveRole('workers: [glm]\nprofileAutoCompactWindow: { mimo: 300000, kimi/kimi: 350000, nope: 200000 }', ['mimo', 'kimi', 'glm'])
    expect(group?.warnings).toContain('profileAutoCompactWindow: "mimo" is not one of the group\'s profiles; it applies only to members on that profile')
    expect(group?.warnings).toContain('profileAutoCompactWindow: "kimi/kimi" is not one of the group\'s profiles; it applies only to members on that profile')
    expect(group?.warnings).toContain('profileAutoCompactWindow: "nope" is not defined; ignored')
    expect(group?.profileAutoCompactWindow).toEqual({ mimo: 300000, kimi: 350000 })
    expect(windows).toEqual({ mimo: 300000, kimi: 350000, glm: undefined })
  })

  test('the role keys parse as plain frontmatter fields and never reject the file', () => {
    const parsed = parseGroupFile('devs', '---\nautoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 300000 }\n---\nBuild.')
    expect(parsed.ok && parsed.group.autoCompactWindow).toBe(250000)
    expect(parsed.ok && parsed.group.profileAutoCompactWindow).toEqual({ mimo: 300000 })
    const bad = parseGroupFile('devs', '---\nautoCompactWindow: lots\nprofileAutoCompactWindow: nope\n---\nBuild.')
    expect(bad.ok).toBe(true)
    if (bad.ok) expect(bad.group.warnings).toHaveLength(2)
  })
})

describe('row V1: read-only group metadata', () => {
  // @covers: agent-teams › Role compaction preferences apply at agent start › Read-only role inspection
  test('V1 the member row exposes the role default, the resolved per-profile map and the warnings', () => {
    writeRole('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo/mimo: 300000, sonnet: 99999 }')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    const row = memberRows(catalog, [], () => ({}))[0]!
    expect(row.autoCompactWindow).toBe(250000)
    expect(row.profileAutoCompactWindow).toEqual({ mimo: 300000 })
    expect(row.profileAutoCompactWindow).not.toBe(catalog.groups.get('devs')!.group.profileAutoCompactWindow)
    expect(row.warnings).toContain('profileAutoCompactWindow.sonnet must be an integer from 100000 to 1000000, got "99999"; ignored')
    writeRole('label: Devs')
    const bare = memberRows(loadGroupCatalog({ groupsRoot: repo, homeDir: home }), [], () => ({}))[0]!
    expect('autoCompactWindow' in bare || 'profileAutoCompactWindow' in bare).toBe(false)
  })
})
