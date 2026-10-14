import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { groupCatalogStamp, loadGroupCatalog } from '../team/groupCatalog'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS } from '../team/groupFile'

describe('loadGroupCatalog', () => {
  let root: string
  let home: string
  let repo: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-groups-'))
    home = path.join(root, 'home')
    repo = path.join(root, 'repo')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (base: string, name: string, content: string) => {
    const dir = path.join(base, '.kawai', 'groups')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }

  test('discovers project groups in id order and ignores non-markdown files', () => {
    write(repo, 'devs.md', 'Build.')
    write(repo, 'architects.md', '---\nlabel: Architects\n---\nDesign.')
    write(repo, 'notes.txt', 'not a group')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['architects', 'devs'])
    expect(catalog.groups.get('architects')?.label).toBe('Architects')
    expect(catalog.errors).toEqual([])
  })

  test('user-level groups are available when the project does not define them', () => {
    write(home, 'qa.md', 'Test.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('qa')?.prompt).toBe('Test.')
  })

  test('a project file replaces the user-level file with the same id', () => {
    write(home, 'devs.md', '---\ndescription: home devs\n---\nHome prompt.')
    write(repo, 'devs.md', 'Project prompt.')
    const devs = loadGroupCatalog({ groupsRoot: repo, homeDir: home }).groups.get('devs')
    expect(devs).toEqual({
      id: 'devs', label: 'devs', description: '', canCreateTasks: false, max: 1, approval: 'manual', prompt: 'Project prompt.',
      profiles: [], strategy: 'first-available', warnings: [],
      onLimit: { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' },
    })
  })

  test('project task settings replace user-level settings wholesale, never merge', () => {
    write(home, 'leads.md', '---\ncanCreateTasks: true\nmax: 4\nprofile: glm\napproval: auto\n---\nHome.')
    write(repo, 'leads.md', '---\nmax: 2\n---\nProject.')
    const leads = loadGroupCatalog({ groupsRoot: repo, homeDir: home }).groups.get('leads')
    expect(leads).toMatchObject({ canCreateTasks: false, max: 2, approval: 'manual', prompt: 'Project.' })
    expect(leads?.profiles).toEqual([])
  })

  test('a malformed task setting skips the project file and keeps the user-level group', () => {
    write(home, 'leads.md', '---\ncanCreateTasks: true\n---\nHome.')
    write(repo, 'leads.md', '---\nmax: lots\n---\nProject.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('leads')).toMatchObject({ canCreateTasks: true, prompt: 'Home.' })
    expect(catalog.errors.some(error => error.includes('leads.md') && error.includes('max must be'))).toBe(true)
  })

  test('invalid ids and malformed files are reported with their path and skipped', () => {
    write(repo, 'Team Lead.md', 'Lead.')
    write(repo, 'broken.md', '---\nlabel: Broken\n')
    write(repo, 'devs.md', 'Build.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['devs'])
    expect(catalog.errors).toHaveLength(2)
    expect(catalog.errors.some(e => e.includes(path.join(repo, '.kawai', 'groups', 'Team Lead.md')))).toBe(true)
    expect(catalog.errors.some(e => e.includes('broken.md') && e.includes('not closed'))).toBe(true)
  })

  test('no groups directories at all is an empty, error-free catalog', () => {
    expect(loadGroupCatalog({ groupsRoot: repo, homeDir: home })).toEqual({ groups: new Map(), errors: [], warnings: [] })
  })

  test('a project rooted at home reads its groups directory once', () => {
    write(home, 'devs.md', 'Build.')
    const catalog = loadGroupCatalog({ groupsRoot: home, homeDir: home })
    expect([...catalog.groups.keys()]).toEqual(['devs'])
  })

  test('an unreadable groups path is reported', () => {
    fs.mkdirSync(path.join(repo, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'groups'), 'a file, not a directory')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.errors).toHaveLength(1)
  })

  test('profile ids the profile catalog does not define are dropped with a warning', () => {
    write(repo, 'devs.md', '---\nprofiles: { glm: 2, nope: 1, default: 1 }\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    const devs = catalog.groups.get('devs')!
    expect(devs.profiles).toEqual([{ profileId: 'glm', cap: 2 }, { profileId: 'default', cap: 1 }])
    expect(devs.warnings).toEqual(['profile "nope" is not defined; ignored'])
    expect(catalog.warnings).toEqual([`${path.join(repo, '.kawai', 'groups', 'devs.md')}: profile "nope" is not defined; ignored`])
    expect(catalog.errors).toEqual([])
  })

  test('a project profile catalog makes its profiles known to groups', () => {
    write(repo, 'devs.md', '---\nprofiles: [mine]\n---\nBuild.')
    fs.writeFileSync(path.join(repo, '.kawai', 'profiles.json'), JSON.stringify({ mine: { label: 'Mine' } }))
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.groups.get('devs')?.profiles).toEqual([{ profileId: 'mine' }])
    expect(catalog.warnings).toEqual([])
  })

  test('file fallback warnings are reported with the path', () => {
    write(repo, 'devs.md', '---\nonLimit: { parkIfResetWithin: soon }\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.warnings).toHaveLength(1)
    expect(catalog.warnings[0]).toContain('devs.md: onLimit.parkIfResetWithin "soon"')
  })

  test('an invalid effort is a path-prefixed warning; the group stays available', () => {
    write(repo, 'devs.md', '---\neffort: extreme\n---\nBuild.')
    const catalog = loadGroupCatalog({ groupsRoot: repo, homeDir: home })
    expect(catalog.errors).toEqual([])
    expect(catalog.groups.get('devs')?.effort).toBeUndefined()
    expect(catalog.warnings).toEqual([
      `${path.join(repo, '.kawai', 'groups', 'devs.md')}: effort must be low, medium, high, xhigh, max, got "extreme"; ignored`,
    ])
  })

  test('the change stamp moves when a profile catalog file changes', () => {
    write(repo, 'devs.md', 'Build.')
    const before = groupCatalogStamp({ groupsRoot: repo, homeDir: home })
    fs.writeFileSync(path.join(repo, '.kawai', 'profiles.json'), '{}')
    expect(groupCatalogStamp({ groupsRoot: repo, homeDir: home })).not.toBe(before)
  })
})
