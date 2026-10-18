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
        { id: 'devs', label: 'Developers', description: '', profiles: [] },
        { id: 'qa', label: 'qa', description: 'Tests', profiles: [] },
      ],
      errors: [],
      warnings: [],
    })
  })

  test('reports an invalid canManageMailbox as a warning and keeps the group', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'lead.md'), '---\ncanManageMailbox: maybe\n---\nLead.')
    const body = await get(`?projectPath=${encodeURIComponent(project)}`) as { groups: Array<{ id: string }>; warnings: string[] }
    expect(body.groups.map(group => group.id)).toEqual(['lead'])
    expect(body.warnings.join()).toContain('canManageMailbox must be true or false, got "maybe"')
  })

  test('reports fallback warnings such as unknown profiles', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), '---\nprofiles: [glm, nope]\n---\nBuild.')
    const body = await get(`?projectPath=${encodeURIComponent(project)}`) as { warnings: string[] }
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0]).toContain('profile "nope" is not defined')
  })

  test('lists allowed profiles with caps and live member counts', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), '---\nprofiles: { glm: 2, default: 1 }\n---\nBuild.')
    const counts: Array<[string, string]> = []
    const routes = createTeamGroupRoutes({
      homeDir: home,
      groupProfileCounts: (teamId, groupId) => { counts.push([teamId, groupId]); return { glm: 2 } },
    })
    const body = await (await routes.request(`/?projectPath=${encodeURIComponent(project)}`)).json() as { groups: unknown[] }
    expect(body.groups).toEqual([{
      id: 'devs', label: 'devs', description: '',
      profiles: [
        { profileId: 'glm', providerId: 'zai', providerLabel: 'Z.AI', cap: 2, live: 2 },
        { profileId: 'default', providerId: 'claude', providerLabel: 'Claude', cap: 1, live: 0 },
      ],
    }])
    expect(counts[0]![1]).toBe('devs')
  })

  test('reports a malformed group file', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'broken.md'), '---\nlabel: x\n')
    const body = await get(`?projectPath=${encodeURIComponent(project)}`) as { groups: unknown[]; errors: string[] }
    expect(body.groups).toEqual([])
    expect(body.errors[0]).toContain('broken.md')
  })

  test('a missing or nonexistent project yields no groups', async () => {
    expect(await get('')).toEqual({ groups: [], errors: [], warnings: [] })
    expect(await get(`?projectPath=${encodeURIComponent(path.join(root, 'nope'))}`)).toEqual({ groups: [], errors: [], warnings: [] })
  })
})
