import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTeamGroupRoutes } from '../routes/teamGroups'

describe('team group routes', () => {
  let root: string
  let project: string
  let home: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-group-routes-')))
    project = path.join(root, 'project')
    home = path.join(root, 'home')
    for (const base of [project, home]) fs.mkdirSync(path.join(base, '.kawai', 'groups'), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const get = async (query: string) =>
    (await createTeamGroupRoutes({ homeDir: home }).request(`/${query}`)).json()

  test('lists layered groups without their role prompts', async () => {
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'qa.md'), '---\ndescription: Tests\n---\nSecret prompt.')
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild.')
    expect(await get(`?projectPath=${encodeURIComponent(project)}`)).toEqual({
      groups: [
        { id: 'devs', label: 'Developers', description: '' },
        { id: 'qa', label: 'qa', description: 'Tests' },
      ],
      errors: [],
    })
  })

  test('reports a malformed group file', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'broken.md'), '---\nlabel: x\n')
    const body = await get(`?projectPath=${encodeURIComponent(project)}`) as { groups: unknown[]; errors: string[] }
    expect(body.groups).toEqual([])
    expect(body.errors[0]).toContain('broken.md')
  })

  test('a missing or nonexistent project yields no groups', async () => {
    expect(await get('')).toEqual({ groups: [], errors: [] })
    expect(await get(`?projectPath=${encodeURIComponent(path.join(root, 'nope'))}`)).toEqual({ groups: [], errors: [] })
  })
})
