import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { outboundFile } from '../outbound/destinations'
import { SessionTeams } from '../team/sessionTeams'

describe('SessionTeams', () => {
  let root: string
  let a: string
  let b: string
  let home: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-session-teams-')))
    a = path.join(root, 'a')
    b = path.join(root, 'b')
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(a, '.kawai', 'groups'), { recursive: true })
    fs.mkdirSync(b)
    fs.writeFileSync(path.join(a, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild.')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test('tracks teams, lists members, and reports group display state', async () => {
    const resolved: string[] = []
    const teams = new SessionTeams({ homeDir: home, onResolved: id => resolved.push(id) })
    expect(teams.groupInfo('s1', 'devs')).toBeUndefined()
    await Promise.all([teams.track('s1', a), teams.track('s2', a), teams.track('s3', b)])
    expect(resolved.sort()).toEqual(['s1', 's2', 's3'])
    expect(teams.membersOf(a).sort()).toEqual(['s1', 's2'])
    expect(teams.groupInfo('s1', 'devs')).toEqual({ label: 'Developers', missing: false })
    expect(teams.groupInfo('s1', 'qa')).toEqual({ label: 'qa', missing: true })

    // Same path again: no re-resolution, no callback.
    await teams.track('s1', a)
    expect(resolved).toHaveLength(3)
    // Moving to another team re-resolves and notifies.
    await teams.track('s1', b)
    expect(resolved).toHaveLength(4)
    expect(teams.membersOf(b).sort()).toEqual(['s1', 's3'])

    teams.forget('s3')
    expect(teams.teamOf('s3')).toBeUndefined()
  })

  test('promptFor reads the role at call time and degrades without a team or group', async () => {
    const teams = new SessionTeams({ homeDir: home })
    expect(teams.promptFor('s1', 'devs')).toContain('(this team defines no groups yet)')
    await teams.track('s1', a)
    expect(teams.promptFor('s1', 'devs')).toContain('# Your role: Developers')
    fs.writeFileSync(path.join(a, '.kawai', 'groups', 'devs.md'), '---\nlabel: Builders\n---\nShip it.')
    expect(teams.promptFor('s1', 'devs')).toContain('# Your role: Builders\n\nShip it.')
    expect(teams.promptFor('s1', 'gone')).not.toContain('# Your role')
    expect(teams.promptFor('s1', null)).toContain('You belong to no group')
  })

  test('promptFor carries the outbound facts read from the loader at call time', async () => {
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['example.internal'] }))
    const teams = new SessionTeams({ homeDir: home })
    await teams.track('s1', a)
    // With and without a group: the section and the configured entry ride along.
    expect(teams.promptFor('s1', 'devs')).toContain('Internal destinations the owner configured: example.internal.')
    expect(teams.promptFor('s1', null)).toContain('Internal destinations the owner configured: example.internal.')
    expect(teams.promptFor('s1', 'devs')).toContain('# Outbound actions')
    // The empty configuration renders the none line instead.
    fs.rmSync(outboundFile(home))
    expect(teams.promptFor('s1', 'devs')).toContain(
      'Internal destinations the owner configured: none beyond loopback and private network addresses.'
    )
  })

  test('effortFor reads the group effort at call time and is unset otherwise', async () => {
    const teams = new SessionTeams({ homeDir: home })
    const devs = path.join(a, '.kawai', 'groups', 'devs.md')
    fs.writeFileSync(devs, '---\neffort: medium\n---\nBuild.')
    expect(teams.effortFor('s1', 'devs', 'default')).toBeUndefined()
    await teams.track('s1', a)
    expect(teams.effortFor('s1', 'devs', 'default')).toBe('medium')
    fs.writeFileSync(devs, '---\nlabel: Developers\neffort: max\n---\nBuild it.')
    expect(teams.effortFor('s1', 'devs', 'default')).toBe('max')
    fs.writeFileSync(devs, '---\nlabel: Developers\n---\nBuild it.')
    expect(teams.effortFor('s1', 'devs', 'default')).toBeUndefined()
    expect(teams.effortFor('s1', 'gone', 'default')).toBeUndefined()
    expect(teams.effortFor('s1', null, 'default')).toBeUndefined()
    expect(teams.effortFor('s1', undefined, 'default')).toBeUndefined()
  })

  test('effortFor: a profile entry wins, else the group effort, else none (group-profile-effort D2)', async () => {
    const teams = new SessionTeams({ homeDir: home })
    const devs = path.join(a, '.kawai', 'groups', 'devs.md')
    fs.writeFileSync(devs, '---\neffort: low\nprofileEffort: { haiku: xhigh, default: high }\n---\nBuild.')
    await teams.track('s1', a)
    expect(teams.effortFor('s1', 'devs', 'haiku')).toBe('xhigh')
    expect(teams.effortFor('s1', 'devs', 'default')).toBe('high')
    expect(teams.effortFor('s1', 'devs', 'glm-flash')).toBe('low')
    // Without a group effort, only the listed profile gets one.
    fs.writeFileSync(devs, '---\nprofileEffort: { haiku: xhigh }\n---\nBuild.')
    expect(teams.effortFor('s1', 'devs', 'haiku')).toBe('xhigh')
    expect(teams.effortFor('s1', 'devs', 'sonnet')).toBeUndefined()
    expect(teams.effortFor('s1', null, 'haiku')).toBeUndefined()
  })

  test('a superseded resolution is dropped', async () => {
    const resolved: string[] = []
    const teams = new SessionTeams({ homeDir: home, onResolved: id => resolved.push(id) })
    const first = teams.track('s1', a)
    teams.forget('s1')
    await first
    expect(resolved).toEqual([])
    expect(teams.teamOf('s1')).toBeUndefined()
  })

  test('the catalog is reused while its files are unchanged and re-read once they move', async () => {
    const teams = new SessionTeams({ homeDir: home })
    await teams.track('s1', a)
    expect(teams.groupInfo('s1', 'devs')).toEqual({ label: 'Developers', missing: false })
    // Unchanged files serve the same parsed catalog (a per-cycle map sees it too).
    const warm = teams.catalogOf('s1')
    expect(teams.catalogOf('s1')).toBe(warm)
    const cycle = new Map()
    expect(teams.catalogOf('s1', cycle)).toBe(warm)
    // An edit changes the stamp: the next read re-reads and sees it.
    fs.writeFileSync(path.join(a, '.kawai', 'groups', 'devs.md'), '---\nlabel: Builders\n---\nShip it.')
    expect(teams.catalogOf('s1')).not.toBe(warm)
    expect(teams.groupInfo('s1', 'devs')).toEqual({ label: 'Builders', missing: false })
    // Files joining and leaving the listing are equally visible.
    fs.writeFileSync(path.join(a, '.kawai', 'groups', 'qa.md'), '---\nlabel: QA\n---\nTest.')
    expect(teams.groupInfo('s1', 'qa')).toEqual({ label: 'QA', missing: false })
    fs.rmSync(path.join(a, '.kawai', 'groups', 'qa.md'))
    expect(teams.groupInfo('s1', 'qa')).toEqual({ label: 'qa', missing: true })
  })
})
