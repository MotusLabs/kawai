// Restart reconciliation (owner-publication-handoff D7, task 7.1): Table
// H-RESTART's healthy tuples and paired witnesses, each classified from the
// database before a real restart through `SessionMailbox.start()`, and the
// model-based property P4 over healthy histories (`helpers/handoffRestartModel.ts`):
// requests, prepared, ordinary and linked-draft publications, the
// reserved-key collisions (plain, draft-shaped and from a genuinely linked
// draft), settlements, a close and restarts. Each case crashes at one named
// boundary — the request insert, the publish transaction (prepared, linked
// or ordinary), the draft load, the status transaction, or the reconcile
// sweep — by a fault inside the transaction (rollback) or a throw right
// after its commit, then reopens the file and starts the production
// mailbox. After every command the handoffs' event histories, the
// revisions, the durable wakeup rows with their mail and the linked draft
// equal the independent model, every pending handoff still classifies
// healthy (H29, no U-claim) and the linked draft has no U7; every reopen
// writes nothing (a healthy sweep makes no writes). The DF sweep faults are
// taskHandoffSweepFaults.integration.test.ts; CP3 through the full
// chat-session composition is taskHandoffRecovery.integration.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SessionDatabase } from '../db'
import { H_DRAFT_SAVE, H_RESTART, classify, observeDraft, observeRestart } from './helpers/handoffClassifier'
import { createRestartBench, type Life, type RestartBench } from './helpers/handoffRestartBench'
import { apply, BOUNDARY, command, emptyModel, KINDS, stored, strayMail, SWEEP_WRITES, type Kind } from './helpers/handoffRestartModel'
import { propertyCases } from './helpers/propertyCases'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { SYSTEM_ACTOR } from '../../shared/team'

let bench: RestartBench
let sequence = 0
beforeAll(async () => { bench = await createRestartBench('kawai-handoff-restart-') })
afterAll(() => bench.dispose())

describe('H-RESTART through SessionMailbox.start()', () => {
  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A restart changes nothing settled
  test('H29: open with a current base and stale (behind, and the tolerated current) are unchanged with no mail; witnesses (1) and (2) classified first', async () => {
    const file = bench.freshFile()
    const first = await bench.open(file, false)
    const tasks = first.runtime.tasks
    const seed = async (title: string) => {
      const task = tasks.store.create({ teamId: bench.team.teamId, title, direction: 'v1', creator: SYSTEM_ACTOR })
      const { handoff } = await tasks.handoffs.request({ kind: 'agent', sessionId: 'lead' }, task.id, { baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: 'k1' })
      return { task, handoff }
    }
    const witness1 = await seed('witness 1')
    const witness2 = await seed('witness 2')
    first.sdb.db.prepare('INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, request_key) VALUES (?, 2, ?, \'human\', \'now\', ?)')
      .run(witness2.task.id, 'orphan', `handoff:${witness2.handoff.id}`)
    first.sdb.db.prepare('UPDATE team_task_handoffs SET base_revision = 2 WHERE id = ?').run(witness2.handoff.id)
    first.sdb.db.prepare('UPDATE team_tasks SET revision = 2 WHERE id = ?').run(witness2.task.id)
    const behind = await seed('stale behind')
    await tasks.publish({ kind: 'human', team: bench.team }, behind.task.id, { direction: 'Mine', rationale: 'r', notify: false })
    const tolerated = await seed('stale current')
    first.sdb.db.prepare("UPDATE team_task_handoffs SET state = 'stale' WHERE id = ?").run(tolerated.handoff.id)
    const ids = [witness1, witness2, behind, tolerated].map(entry => entry.handoff.id)
    const classes = ids.map(id => classify(H_RESTART, observeRestart(first.sdb.db, id)))
    expect(classes).toEqual([
      { kind: 'healthy', row: 'H29' }, { kind: 'excluded', reasons: ['U6'] }, { kind: 'healthy', row: 'H29' }, { kind: 'healthy', row: 'H29', tolerated: true },
    ])
    const dump = (db: SessionDatabase['db']) => bench.dump(db)
    const before = dump(first.sdb.db)
    first.close()
    const second = await bench.open(file)
    try {
      expect(dump(second.sdb.db)).toEqual(before)
    } finally {
      second.close()
    }
  })
})

class CrashAfterCommit extends Error {}

/** The boundaries every run crashes at, each by both kinds; a case's prefix makes its command effective. */
const TARGETS: Array<{ boundary: string; kind: Kind; prefix: Kind[] }> = [
  { boundary: 'the request insert', kind: 'request', prefix: [] },
  { boundary: 'the publish transaction (prepared)', kind: 'publish', prefix: ['request'] },
  { boundary: 'the publish transaction (linked draft)', kind: 'linked-publish', prefix: ['request', 'load'] },
  { boundary: 'the publish transaction (ordinary over a pending handoff)', kind: 'other', prefix: ['request'] },
  { boundary: 'the draft load', kind: 'load', prefix: ['request'] },
  { boundary: 'the status transaction', kind: 'close', prefix: ['request'] },
  { boundary: 'the reconcile sweep', kind: 'restart', prefix: ['request', 'load'] },
]
const CRASHES = ['rollback', 'after-commit'] as const

/** Reopen the file and start the production mailbox; `armSweep` arms a fault on every sweep write first (it must never fire). */
async function reopen(life: Life, file: string, armSweep = false): Promise<Life> {
  life.close()
  if (!armSweep) return bench.open(file)
  const next = await bench.open(file, false)
  for (const [at, [table, event]] of SWEEP_WRITES.entries()) next.sdb.db.exec(`CREATE TRIGGER sweep_${at} AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'sweep wrote'); END`)
  try {
    next.runtime.start()
  } finally {
    for (const at of SWEEP_WRITES.keys()) next.sdb.db.exec(`DROP TRIGGER IF EXISTS sweep_${at}`)
  }
  return next
}

/** Every pending handoff of the task classifies healthy (H29, no U-claim) and its linked draft has no U7. */
function unhealthy(db: SessionDatabase['db'], taskId: string): unknown[] {
  const ids = (db.prepare("SELECT id FROM team_task_handoffs WHERE task_id = ? AND state IN ('open', 'stale')").all(taskId) as Array<{ id: string }>).map(row => row.id)
  const draft = observeDraft(db, taskId)
  return [
    ...ids.map(id => classify(H_RESTART, observeRestart(db, id))).filter(result => result.kind !== 'healthy'),
    ...(draft ? [classify(H_DRAFT_SAVE, { command: 'save', observed: 'stored', base: 'unchanged', ...draft })].filter(result => result.kind !== 'healthy') : []),
  ]
}

describe('P4: crash recovery', () => {
  const CASES = 200
  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A crash after publication
  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A refused key changes nothing at restart
  test('P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state', async () => {
    const random = mulberry32(0x0A11CE04)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const effective = new Set<string>()
    for (let index = 0; index < propertyCases(CASES); index++) {
      const target = TARGETS[index % TARGETS.length]!
      const crashKind = CRASHES[Math.floor(index / TARGETS.length) % CRASHES.length]!
      const file = bench.freshFile()
      let life = await bench.open(file)
      const task = life.runtime.tasks.store.create({ teamId: bench.team.teamId, title: `P4 ${index}`, direction: 'v1', creator: SYSTEM_ACTOR })
      const model = emptyModel()
      const before = Array.from({ length: Math.floor(random() * 4) }, () => pick(KINDS))
      const kinds: Kind[] = [...before, ...target.prefix, target.kind, ...Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(KINDS))]
      const crashAt = before.length + target.prefix.length
      try {
        for (const [position, kind] of kinds.entries()) {
          const crash = position === crashAt
          const label = [index, kinds, position, crash ? `${target.boundary}: ${crashKind}` : 'none']
          if (model.closed && (kind === 'other' || kind === 'linked-publish')) continue
          if (kind === 'restart') {
            const rows = bench.sweepDump(life.sdb.db)
            life = await reopen(life, file, crash && crashKind === 'rollback')
            // A crash right after the sweep's commit: the next boot runs it again.
            if (crash && crashKind === 'after-commit') life = await reopen(life, file)
            expect([...label, 'the sweep wrote', bench.sweepDump(life.sdb.db)]).toEqual([...label, 'the sweep wrote', rows])
            if (crash) effective.add(`${target.boundary}: ${crashKind}`)
          } else {
            let unsubscribe = () => {}
            if (crash && crashKind === 'rollback') {
              const [table, event] = BOUNDARY[kind]
              life.sdb.db.exec(`CREATE TRIGGER crash AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'crash'); END`)
            }
            if (crash && crashKind === 'after-commit') {
              // Only the announcement of the command's own committed write crashes (a draft has none: the throw follows its return).
              const armed = JSON.stringify(stored(life.runtime, task.id))
              unsubscribe = life.runtime.tasks.store.subscribe(() => {
                if (JSON.stringify(stored(life.runtime, task.id)) === armed) return
                unsubscribe()
                throw new CrashAfterCommit('crash after commit')
              })
            }
            try {
              await command(life.runtime, bench.team, task.id, kind, ++sequence)
            } catch (error) {
              // A refusal, the injected fault, or the throw right after a commit.
              if (!(error instanceof Error)) throw error
            } finally {
              unsubscribe()
            }
            // The reference model: a refused command changes nothing; a fault inside the transaction rolls it back; one after its commit keeps it.
            const changed = structuredClone(model)
            apply(changed, kind, kind === 'rerequest' ? 'lead2' : 'lead')
            if (crash && JSON.stringify(changed) !== JSON.stringify(model)) effective.add(`${target.boundary}: ${crashKind}`)
            if (!(crash && crashKind === 'rollback')) Object.assign(model, changed)
            if (crash) {
              if (crashKind === 'rollback') life.sdb.db.exec('DROP TRIGGER IF EXISTS crash')
              const rows = bench.sweepDump(life.sdb.db)
              life = await reopen(life, file)
              expect([...label, 'the sweep wrote', bench.sweepDump(life.sdb.db)]).toEqual([...label, 'the sweep wrote', rows])
            }
          }
          expect([...label, stored(life.runtime, task.id), strayMail(life.runtime, task.id), unhealthy(life.sdb.db, task.id)]).toEqual([...label, model, 0, []])
        }
        life = await reopen(life, file)
        expect([index, kinds, 'final restart', stored(life.runtime, task.id), strayMail(life.runtime, task.id)]).toEqual([index, kinds, 'final restart', model, 0])
      } finally {
        life.close()
      }
    }
    // Every named boundary crashed by both kinds on a command that writes (not only on refusals).
    expect([...effective].sort()).toEqual(TARGETS.flatMap(entry => CRASHES.map(kind => `${entry.boundary}: ${kind}`)).sort())
  }, 600_000)
})
