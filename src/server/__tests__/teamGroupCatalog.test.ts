import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadGroupCatalog } from '../team/groupCatalog'

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
    expect(devs).toEqual({ id: 'devs', label: 'devs', description: '', prompt: 'Project prompt.' })
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
    expect(loadGroupCatalog({ groupsRoot: repo, homeDir: home })).toEqual({ groups: new Map(), errors: [] })
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
})
