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
      approvalDefault: null,
      setupAvailable: false,
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

  // unify-approval-defaults D2: the team default seeds the dialog's Auto-approve box.
  test('names the team default approval policy of the resolved team: auto, manual, or null', async () => {
    const asked: string[] = []
    const stored = new Map<string, 'manual' | 'auto'>()
    const routes = createTeamGroupRoutes({
      homeDir: home,
      approvalDefault: teamId => { asked.push(teamId); return stored.get(teamId) ?? null },
    })
    const read = async () => (await (await routes.request(`/?projectPath=${encodeURIComponent(project)}`)).json() as { approvalDefault: unknown }).approvalDefault
    expect(await read()).toBeNull()
    const teamId = asked[0]!
    stored.set(teamId, 'auto')
    expect(await read()).toBe('auto')
    stored.set(teamId, 'manual')
    expect(await read()).toBe('manual')
    expect(new Set(asked)).toEqual(new Set([teamId]))
  })

  // starter-team-setup D2 (Table O): the New Session notice reads this flag;
  // only project `*.md` files withdraw it, user-level groups never do.
  test('setupAvailable is true exactly while the project groups directory holds no group file', async () => {
    const available = async () => (await get(`?projectPath=${encodeURIComponent(project)}`) as { setupAvailable: boolean }).setupAvailable
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'qa.md'), '---\nlabel: QA\n---\nTest.')
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'notes.txt'), 'not a group')
    expect(await available()).toBe(true)
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'broken.md'), '---\nlabel: x\n')
    expect(await available()).toBe(false)
  })

  // starter-setup-with-user-level-groups (Table N, route evidence): one
  // answer carries the groups the dialog offers and the project-only offer,
  // so what the picker shows and whether it points to setup are read side by
  // side from real user-level files.
  // @covers: team-setup › The New Session dialog points a team without groups to setup › User-level groups hide the notice
  test('a valid user-level group file is offered in the same answer that still offers setup', async () => {
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'reviewers-sol.md'), '---\nlabel: Reviewers (Sol)\n---\nReview.')
    expect(await get(`?projectPath=${encodeURIComponent(project)}`)).toEqual({
      groups: [{ id: 'reviewers-sol', label: 'Reviewers (Sol)', description: '', profiles: [] }],
      errors: [], warnings: [], approvalDefault: null, setupAvailable: true,
    })
  })

  // @covers: team-setup › The New Session dialog points a team without groups to setup › Unparsed user-level files do not hide the notice
  test('a user-level file that fails to parse offers no group, is reported by path, and leaves the setup offer', async () => {
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'reviewers-sol.md'), '---\nlabel: x\n')
    expect(await get(`?projectPath=${encodeURIComponent(project)}`)).toEqual({
      groups: [],
      errors: [`${path.join(home, '.kawai', 'groups', 'reviewers-sol.md')}: frontmatter is not closed by ---`],
      warnings: [], approvalDefault: null, setupAvailable: true,
    })
  })

  test('a project group file withdraws the setup offer while the user-level group stays offered', async () => {
    fs.writeFileSync(path.join(home, '.kawai', 'groups', 'reviewers-sol.md'), '---\nlabel: Reviewers (Sol)\n---\nReview.')
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'lead.md'), '---\nlabel: Lead\n---\nPlan.')
    const body = await get(`?projectPath=${encodeURIComponent(project)}`) as { groups: Array<{ id: string }>; setupAvailable: boolean }
    expect(body.groups.map(group => group.id)).toEqual(['lead', 'reviewers-sol'])
    expect(body.setupAvailable).toBe(false)
  })

  test('a missing or nonexistent project yields no groups', async () => {
    expect(await get('')).toEqual({ groups: [], errors: [], warnings: [], approvalDefault: null, setupAvailable: false })
    expect(await get(`?projectPath=${encodeURIComponent(path.join(root, 'nope'))}`)).toEqual({ groups: [], errors: [], warnings: [], approvalDefault: null, setupAvailable: false })
  })

  // Review F2 (findings ff0fa041): a looping groups entry — which any
  // repo-writing agent can create — must degrade the route's flag, not 500.
  test('a looping groups entry reports unavailable instead of failing the route', async () => {
    fs.rmdirSync(path.join(project, '.kawai', 'groups')) // the harness seeds a real dir; replace it with the loop
    fs.symlinkSync('groups', path.join(project, '.kawai', 'groups'))
    const response = await createTeamGroupRoutes({ homeDir: home }).request(`/?projectPath=${encodeURIComponent(project)}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { setupAvailable: boolean; errors: string[] }
    expect(body.setupAvailable).toBe(false)
    expect(body.errors.join()).toContain('groups')
  })
})
