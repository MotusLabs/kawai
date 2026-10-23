// I6 (plan-workspace §4): a contextual send carries no authority — it never
// sets the session's task association, never moves the turn-usage pin, and
// writes nothing to the plan store. The send runs through the development
// fixture so the observable outcome is the real composition.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'
import type { WorkspaceMessageEnvelope } from '../../shared/planWorkspace'

describe('I6 a contextual send carries no authority', () => {
  let tempDir: string
  let project: string
  let db: SessionDatabase
  let registry: SessionRegistry

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-pwd-i6-')))
    project = path.join(tempDir, 'project')
    fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    registry = new SessionRegistry()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createManager = () => new ChatSessionManager({
    db, registry, onEvent: () => {}, profileCatalogHome: tempDir, authCheck: () => true,
    queryFactory: fixtureQueryFactory,
  })
  const waitFor = async (check: () => boolean, label: string) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > 5000) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  test('a delivered contextual send leaves the task association, the usage pin, and the plan store untouched', async () => {
    const manager = createManager()
    const team = await resolveTeam(project)
    const planCreated = await manager.plans.create({ kind: 'human', team }, { title: 'Roadmap' })
    const task = await manager.tasks.create({ kind: 'human', team }, { title: 'Export', direction: 'CSV' })
    const created = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: task.id })
    if (!created.ok) throw new Error(created.error)
    const sessionId = created.session.id
    const plansBefore = manager.plans.list({ kind: 'human', team })
    const envelope: WorkspaceMessageEnvelope = {
      teamId: team.teamId,
      planId: planCreated.plan.id,
      version: { kind: 'draft', draftId: planCreated.draft.draftId, contentHash: planCreated.draft.contentHash },
    }
    expect(await manager.send(sessionId, 'hello with context', envelope)).toEqual({ ok: true })
    // The fixture completes the turn, so the usage row exists and shows
    // whose turn it was.
    await waitFor(() => manager.turnUsage.forSession(sessionId).length > 0, 'the usage row')
    // The association on the row and in the registry is still the task the
    // session was created with — the context never rebinds it.
    expect(db.getChatSession(sessionId)?.taskId).toBe(task.id)
    expect(registry.get(sessionId)?.taskId).toBe(task.id)
    const rows = manager.turnUsage.forSession(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.taskId).toBe(task.id)
    // The plan store took no writes: the same summaries, the draft unchanged.
    expect(manager.plans.list({ kind: 'human', team })).toEqual(plansBefore)
  })
})
