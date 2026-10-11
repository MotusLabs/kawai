import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    fs.writeFileSync(path.join(a, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\n')
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

  test('a superseded resolution is dropped', async () => {
    const resolved: string[] = []
    const teams = new SessionTeams({ homeDir: home, onResolved: id => resolved.push(id) })
    const first = teams.track('s1', a)
    teams.forget('s1')
    await first
    expect(resolved).toEqual([])
    expect(teams.teamOf('s1')).toBeUndefined()
  })
})
