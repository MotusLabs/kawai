// owner-publication-handoff CP2 (task 9.4) through the production
// composition: a database holds a running execution whose change `api` is
// implementing, its instruction delivered three hours ago to `dev`, whose
// chat record is archived, and whose ownerless task has an open handoff
// from the live Lead `lead`. Booting ChatSessionManager starts the real
// supervision monitor over the real loader and runtime (liveness from the
// restored chat records): `api` reads the owner-publication wait with the
// human as next actor, the monitor raises no stall-alert row and sends no
// stall mail, and the real workspace read shows W2 and no Lead stall item.
// Declining the handoff ends the wait on the same monitor and clears W2.
// (The monitor seeds every running change's wait time at startup, so a
// boot never stalls at once; the deadline path with the holder named gone
// is S5's, through the derivation and the loader.)
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { WorkspaceRead } from '../team/workspaceRead'
import type { SupervisionMonitor } from '../plans/supervision/SupervisionMonitor'
import { createPlanWorld, sessionRow, writeGroup } from './planHarness'
import { createSupervisionBench } from './supervisionHarness'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 15_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// @covers: plan-supervision › A pending publication handoff is a named wait › A prepared correction waits on the owner
test('CP2: at boot the monitor reads owner-publication for an archived holder with an open handoff, raises no stall alert, and the workspace shows W2 and no Lead stall item', async () => {
  const world = await createPlanWorld('kawai-owner-publication-boot-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(world.root, 'claude')
  try {
    // The state an earlier process left, written through the stores.
    const bench = createSupervisionBench(world)
    const file = bench.db.db.filename
    const planId = await bench.approvedPlan()
    const executionId = bench.start(planId)
    const { taskId } = await bench.implementing(executionId, planId, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString())
    const { handoff } = await bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
      baseRevision: 1, direction: 'Prepared correction', rationale: 'the contract asks for two things', notify: false, requestKey: 'cp2',
    })
    // The chat records the boot restores: the requester live, the holder archived.
    bench.db.db.prepare('DELETE FROM chat_sessions').run()
    bench.db.close()
    const seed = initDatabase({ path: file })
    seed.insertChatSession(sessionRow('lead', 'leads', world.repo))
    seed.insertChatSession({ ...sessionRow('dev', 'middle-devs', world.feature), archivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })
    seed.close()

    const boot = async () => {
      const db = initDatabase({ path: file })
      const manager = new ChatSessionManager({
        db, registry: new SessionRegistry(), onEvent: () => {}, isDirectory: () => true, profileCatalogHome: world.home,
        providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
      })
      await manager.whenRestored()
      const monitor = (manager as unknown as { supervisionMonitor: SupervisionMonitor }).supervisionMonitor
      await waitFor(() => manager.planAttentionFacts(world.team.teamId).length > 0, 'the plan facts')
      await monitor.idle()
      return { db, manager, monitor }
    }
    const stallRows = (db: ReturnType<typeof initDatabase>) =>
      (db.db.prepare("SELECT kind FROM plan_stall_alerts WHERE kind = 'no-progress'").all() as Array<{ kind: string }>).length
    const stallMail = (db: ReturnType<typeof initDatabase>) =>
      (db.db.prepare("SELECT tags FROM team_messages").all() as Array<{ tags: string }>).filter(row => (JSON.parse(row.tags) as string[]).includes('plan-stall')).length

    const first = await boot()
    const api = () => first.manager.planAttentionFacts(world.team.teamId)[0]!.changes.find(change => change.supervision.change === 'api')!.supervision
    expect(api()).toMatchObject({ outcome: 'waiting', stall: null, cause: { kind: 'owner-publication', handoffId: handoff.id, state: 'open', nextActor: { kind: 'human' } } })
    first.monitor.notify(world.team.teamId)
    await first.monitor.idle()
    expect([stallRows(first.db), stallMail(first.db)]).toEqual([0, 0])
    const team = first.manager.teams.identityFor(world.team.teamId)!
    const attention = new WorkspaceRead(first.manager).snapshot(team).attention.filter(item => item.impact.taskId === taskId)
    expect(attention.map(item => ({ kind: item.kind, owner: item.owner.kind, needsHuman: item.requiresHuman, action: item.nextAction })))
      .toEqual([{ kind: 'publication-handoff', owner: 'human', needsHuman: true, action: 'Publish prepared revision' }])

    // The handoff's end is the wait's end (S10): the same monitor reads api without it and W2 leaves.
    await first.manager.tasks.handoffs.settle({ kind: 'human', team }, handoff.id, 'decline', 'not this one')
    await first.monitor.idle()
    expect(api().cause.kind).not.toBe('owner-publication')
    expect(api().alsoApplying.map(wait => wait.kind)).not.toContain('owner-publication')
    expect(new WorkspaceRead(first.manager).snapshot(team).attention.filter(item => item.impact.taskId === taskId)).toEqual([])
    first.manager.shutdown()
    first.db.close()
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(world.root, { recursive: true, force: true })
  }
}, 60_000)
