// D7's sweep under faults (owner-publication-handoff design "Table DF", P4's
// reconcile-sweep boundary): the repairable DF fixtures — DF1 association,
// DF2 closed task, DF3 base behind, DF5 all three — seeded apart from P4's
// healthy histories and classified first (excluded, with their whole reason
// sets). Each boot goes through the production `SessionMailbox.start()`: a
// fault at the sweep's state write, event, wakeup row or mail rolls the
// repair back whole (nothing written, the boot fails); the next boot
// repairs once with its one wakeup and mail; a boot after that committed
// repair writes nothing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { H_RESTART, classify, observeRestart, type Reason } from './helpers/handoffClassifier'
import { createRestartBench, type RestartBench } from './helpers/handoffRestartBench'
import { HANDOFF_WAKEUP_TAG } from '../team/taskHandoffWakeups'
import { SYSTEM_ACTOR } from '../../shared/team'

let bench: RestartBench
beforeAll(async () => { bench = await createRestartBench('kawai-handoff-sweep-faults-') })
afterAll(() => bench.dispose())

interface Fixture { id: string; revisions: number; base: number; associated?: number; closed?: boolean; reasons: Reason[]; repaired: string }
const FIXTURES: Fixture[] = [
  { id: 'DF1', revisions: 2, base: 2, associated: 2, reasons: ['U1'], repaired: 'published' },
  { id: 'DF2', revisions: 1, base: 1, closed: true, reasons: ['U5'], repaired: 'closed' },
  { id: 'DF3', revisions: 2, base: 1, reasons: ['U3'], repaired: 'stale' },
  { id: 'DF5', revisions: 2, base: 1, associated: 2, closed: true, reasons: ['U1', 'U3', 'U5'], repaired: 'published' },
]
const FAULTS: Array<[string, string, 'INSERT' | 'UPDATE']> = [
  ['the state write', 'team_task_handoffs', 'UPDATE'], ['the event', 'team_task_handoff_events', 'INSERT'],
  ['the wakeup row', 'team_task_handoff_wakeups', 'INSERT'], ['the wakeup mail', 'team_messages', 'INSERT'],
]

/** Seed a fixture as an older build or a manual edit could leave it (no hooks run). */
async function seed(file: string, fixture: Fixture): Promise<string> {
  const life = await bench.open(file, false)
  try {
    const { db } = life.sdb
    const tasks = life.runtime.tasks
    const task = tasks.store.create({ teamId: bench.team.teamId, title: `Fixture ${fixture.id}`, direction: 'v1', creator: SYSTEM_ACTOR })
    for (let revision = 2; revision <= fixture.revisions; revision++) {
      db.prepare("INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at) VALUES (?, ?, ?, 'human', 'now')").run(task.id, revision, `v${revision}`)
    }
    db.prepare('UPDATE team_tasks SET revision = ?, status = ? WHERE id = ?').run(fixture.revisions, fixture.closed ? 'cancelled' : 'open', task.id)
    const handoff = tasks.store.atomically(() => tasks.handoffs.store.insert({
      teamId: bench.team.teamId, taskId: task.id, baseRevision: fixture.base, baseContractHash: null, direction: 'Prepared', acceptance: null, contract: null,
      rationale: 'why', notify: false, baseCommit: null, evidenceRefs: [], requesterSession: 'lead', requesterGroup: 'leads', requestKey: 'k1',
    }, 'seeded'))
    if (fixture.associated) db.prepare("UPDATE team_task_revisions SET handoff_id = ?, request_key = 'ordinary-edit' WHERE task_id = ? AND revision = ?").run(handoff.id, task.id, fixture.associated)
    expect([fixture.id, classify(H_RESTART, observeRestart(db, handoff.id))]).toEqual([fixture.id, { kind: 'excluded', reasons: fixture.reasons }])
    return handoff.id
  } finally {
    life.close()
  }
}

/** Faults at each sweep write, then the repairing boot, then a boot after the committed repair. */
async function faultsThenRepair(fixture: Fixture): Promise<void> {
  const file = bench.freshFile()
  const id = await seed(file, fixture)
  const life0 = await bench.open(file, false)
  const seeded = bench.sweepDump(life0.sdb.db)
  life0.close()
  for (const [name, table, event] of FAULTS) {
    const life = await bench.open(file, false)
    life.sdb.db.exec(`CREATE TRIGGER fault AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'sweep fault'); END`)
    try {
      expect([fixture.id, name, (() => { try { life.runtime.start(); return 'started' } catch (error) { return (error as Error).message } })()])
        .toEqual([fixture.id, name, 'sweep fault'])
      life.sdb.db.exec('DROP TRIGGER fault')
      expect([fixture.id, name, bench.sweepDump(life.sdb.db)]).toEqual([fixture.id, name, seeded])
    } finally {
      life.close()
    }
  }
  const repaired = await bench.open(file)
  const { db } = repaired.sdb
  const state = (db.prepare('SELECT state FROM team_task_handoffs WHERE id = ?').get(id) as { state: string }).state
  const wakeups = db.prepare('SELECT transition, message_id IS NOT NULL AS mailed FROM team_task_handoff_wakeups WHERE handoff_id = ?').all(id)
  const mail = db.prepare('SELECT to_kind, to_id FROM team_messages WHERE tags LIKE ? AND body LIKE ?').all(`%${HANDOFF_WAKEUP_TAG}%`, `%${id}%`)
  const events = (db.prepare('SELECT to_state FROM team_task_handoff_events WHERE handoff_id = ? ORDER BY seq').all(id) as Array<{ to_state: string }>).map(row => row.to_state)
  expect({ state, wakeups, mail, events }).toEqual({
    state: fixture.repaired, wakeups: [{ transition: fixture.repaired, mailed: 1 }], mail: [{ to_kind: 'session', to_id: 'lead' }], events: ['open', fixture.repaired],
  })
  const committed = bench.sweepDump(db)
  repaired.close()
  const again = await bench.open(file)
  try {
    expect(bench.sweepDump(again.sdb.db)).toEqual(committed)
  } finally {
    again.close()
  }
}
const named = (id: string) => FIXTURES.find(entry => entry.id === id)!

describe('the sweep under faults through SessionMailbox.start()', () => {
  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A crash after publication
  test('DF1: a fault at each sweep write rolls the repair back; the next boot repairs once with one wakeup and mail; a later boot writes nothing', () => faultsThenRepair(named('DF1')))
  test('DF2: a fault at each sweep write rolls the repair back; the next boot repairs once with one wakeup and mail; a later boot writes nothing', () => faultsThenRepair(named('DF2')))
  test('DF3: a fault at each sweep write rolls the repair back; the next boot repairs once with one wakeup and mail; a later boot writes nothing', () => faultsThenRepair(named('DF3')))
  test('DF5: a fault at each sweep write rolls the repair back; the next boot repairs once with one wakeup and mail; a later boot writes nothing', () => faultsThenRepair(named('DF5')))
  test('every repairable fixture runs', () => expect(FIXTURES.map(entry => entry.id)).toEqual(['DF1', 'DF2', 'DF3', 'DF5']))
})
