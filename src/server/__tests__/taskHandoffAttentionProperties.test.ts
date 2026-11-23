// Properties P2 and P7 (owner-publication-handoff design "Properties", task
// 8.4) over the real decision bench, through the workspace read's handoff
// facts and items:
// - P2 visibility: after every command of P1's seeded command family
//   (`helpers/handoffFamily.ts`: requests, prepared and ordinary
//   publications, linked-draft histories, the real Adapt, settlements, a
//   close, notices in every state, task mail, acknowledgements, archival and
//   revival), the command's handoff side effect matches the model's own
//   transition (stale past a revision, closed by a close, unchanged
//   otherwise) and the items equal what Table W (`helpers/handoffWTable.ts`,
//   the reference model) predicts from the raw rows, read by their own
//   queries, with execution ownership from the case itself (W7).
// - P7 notice actions over random histories of one published revision:
//   P7a — a closed task or an acknowledgement at or above the revision
//   leaves no follow-up item and no notice action; P7b — for an open task
//   with a live claimant below it, **Notify** or **Retry notification** is
//   offered exactly when the real `TaskNotices.notify` with a fresh key
//   writes a new notification row on a copy of the database.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { handoffPhase, type HandoffNoticeState, type TaskHandoff } from '../../shared/taskHandoffs'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskAcknowledgements } from '../team/taskAcknowledgements'
import { followUpFacts } from '../team/taskHandoffFacts'
import { TaskNotices } from '../team/taskNotices'
import { createHandoffAttentionBench, type HandoffAttentionBench, type NoticeMove } from './helpers/handoffAttentionBench'
import { shown, W_PENDING, W_PUBLISHED, type Shown } from './helpers/handoffWTable'
import { propertyCases } from './helpers/propertyCases'
import { createHandoffFamily, familySteps, type HandoffFamily } from './helpers/handoffFamily'

let b: HandoffAttentionBench
beforeAll(async () => { b = await createHandoffAttentionBench('kawai-handoff-attention-properties-') })
afterAll(() => b.close())

const db = () => b.bench.db.db
const tasks = () => b.bench.taskService
const swallow = async (run: () => Promise<unknown>) => { try { await run() } catch { /* a refusal is part of the sequence */ } }
const NOTICES: NoticeMove[] = ['queued', 'delivered', 'uncertain', 'failed']
const live = (session: string) => { const record = b.bench.records.get(session); return !!record && !record.archivedAt && !record.contextExhausted }
const reviveAll = () => { for (const id of ['lead', 'lead2', 'dev']) b.revive(id) }

// The model's own reads of the raw rows (never the source's facts).
const MESSAGE_STATE: Record<string, HandoffNoticeState> = {
  queued: 'queued', claimed: 'queued', spawning: 'queued', 'awaiting-request': 'queued', parked: 'queued', delivered: 'delivered', uncertain: 'uncertain',
  dead: 'failed', cancelled: 'failed', discarded: 'failed', forwarded: 'failed',
}
/** The model over `world` (the P2 family's database and liveness); `owns` is the case's own knowledge of execution ownership. */
interface ModelWorld { db: Database; live: (session: string) => boolean }
function modelItems(world: ModelWorld, taskId: string, claimant: string | null, owns: boolean): Array<{ id: string; shown: Shown }> {
  const { live } = world
  const db = () => world.db
  const one = <T,>(sql: string, ...params: Array<string | number>) => db().prepare(sql).get(...params) as T
  const task = one<{ status: string; owner_session: string | null }>('SELECT status, owner_session FROM team_tasks WHERE id = ?', taskId)
  const closed = task.status === 'done' || task.status === 'cancelled'
  const rows = db().prepare('SELECT * FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<Record<string, string | number | null>>
  return rows.flatMap(row => {
    const id = String(row.id)
    if (row.state === 'open' || row.state === 'stale') {
      const owner = task.owner_session === null ? 'none' : live(task.owner_session) ? 'live' : 'gone'
      const axes = { state: row.state, owner, requester: live(String(row.requester_session)) ? 'live' : 'gone' } as const
      const matched = W_PENDING.filter(entry => entry.match(axes))
      return matched.map(entry => ({ id: `publication-handoff:${id}`, shown: entry.expect }))
    }
    if (row.state !== 'published' || closed) return []
    const revision = Number(row.published_revision)
    const delivered = claimant === null ? null : one<{ r: number | null }>(`SELECT MAX(task_revision) AS r FROM team_messages
      WHERE task_id = ? AND state = 'delivered' AND ((to_kind = 'session' AND to_id = ?) OR claimed_by = ?)`, taskId, claimant, claimant).r
    const acked = claimant === null ? null : one<{ r: number | null }>('SELECT MAX(revision) AS r FROM team_task_acknowledgements WHERE task_id = ? AND session_id = ?', taskId, claimant).r
    const notices = claimant === null ? [] : (db().prepare(`SELECT m.state FROM team_task_notifications n JOIN team_messages m ON m.id = n.message_id
      WHERE n.task_id = ? AND n.recipient_session = ? AND n.revision >= ?`).all(taskId, claimant, revision) as Array<{ state: string }>).map(entry => MESSAGE_STATE[entry.state]!)
    const axes = {
      closed, claimant: claimant === null ? 'none' as const : live(claimant) ? 'live' as const : 'gone' as const,
      acked: (acked ?? 0) >= revision, delivered: (delivered ?? 0) >= revision, notices, owns,
    }
    const matched = W_PUBLISHED.filter(entry => entry.match(axes))
    expect([id, matched.length]).toEqual([id, 1])
    return matched[0]!.expect === null ? [] : [{ id: `publication-follow-up:${id}`, shown: matched[0]!.expect }]
  })
}

/** The task's revision, status and pending handoff, the inputs of P2's own transition model. */
function observed(db: Database, taskId: string) {
  const task = db.prepare('SELECT revision, status FROM team_tasks WHERE id = ?').get(taskId) as { revision: number; status: string }
  const pending = db.prepare("SELECT id, state FROM team_task_handoffs WHERE task_id = ? AND state IN ('open', 'stale')").get(taskId) as { id: string; state: string } | null
  return { ...task, pending }
}
const SETTLING = new Set(['request', 'rerequest', 'decline', 'withdraw', 'publish', 'publish-dup', 'linked-publish'])
/**
 * The W model's side effects of one command, judged from the command's own outcome (the revision and
 * status it left) rather than the source's handoff facts: a revision past an open handoff that is not
 * its fulfilment makes it stale (D4), a close makes it closed, and a command that neither publishes,
 * closes nor settles leaves it as it was.
 */
function transition(db: Database, taskId: string, step: string, before: ReturnType<typeof observed>): string[] {
  if (!before.pending) return []
  const after = observed(db, taskId)
  const state = (db.prepare('SELECT state FROM team_task_handoffs WHERE id = ?').get(before.pending.id) as { state: string }).state
  const fulfilled = !!db.prepare('SELECT 1 FROM team_task_revisions WHERE task_id = ? AND handoff_id = ? AND revision > ?').get(taskId, before.pending.id, before.revision)
  const closed = after.status !== before.status && (after.status === 'done' || after.status === 'cancelled')
  const expected = fulfilled ? 'published'
    : closed ? 'closed'
    : after.revision > before.revision && before.pending.state === 'open' ? 'stale'
    : SETTLING.has(step) ? null : before.pending.state
  return expected === null || expected === state ? [] : [`${step}: ${before.pending.id} is ${state}, the model expects ${expected}`]
}

describe('P2: visibility', () => {
  const CASES = 400
  let family: HandoffFamily
  beforeAll(async () => { family = await createHandoffFamily('kawai-handoff-p2-') })
  afterAll(() => family.close())

  // @covers: team-workspace › The attention queue lists pending publication handoffs › A disposition clears the item
  test('P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W\'s prediction from the rows', async () => {
    const random = mulberry32(0x0A11CE02)
    const world = { db: family.bench.taskService.store.db, live: family.live }
    const seen = new Set<string>()
    for (let index = 0; index < propertyCases(CASES); index++) {
      const item = await family.start(random)
      const steps = familySteps(random, item.kind)
      if (random() < 0.15) steps.push('close')
      for (const [position, step] of steps.entries()) {
        const before = observed(world.db, item.taskId)
        await family.step(item, step, random)
        expect([index, steps.slice(0, position + 1), transition(world.db, item.taskId, step, before)]).toEqual([index, steps.slice(0, position + 1), []])
        const expected = modelItems(world, item.taskId, item.claimant, item.kind === 'paused').sort((x, y) => x.id.localeCompare(y.id))
        for (const entry of expected) seen.add(`${entry.id.split(':')[0]}:${entry.shown?.action}:${entry.shown?.owner}`)
        const actual = family.items([item]).filter(entry => entry.impact.taskId === item.taskId)
          .map(entry => ({ id: entry.id, shown: shown([entry])[0]! })).sort((x, y) => x.id.localeCompare(y.id))
        expect<unknown>([index, item.kind, steps.slice(0, position + 1), actual]).toEqual([index, item.kind, steps.slice(0, position + 1), expected])
      }
    }
    // Every W row with an item was predicted somewhere, W7 (an execution-owned task without a live holder) included.
    expect([...seen].sort()).toEqual([
      'publication-follow-up:Hand off the task:human', 'publication-follow-up:Notify:human', 'publication-follow-up:Resolve in the Mailbox (Retry or Discard):human',
      'publication-follow-up:Retry notification:human', 'publication-follow-up:Wait for Kawai:kawai', 'publication-follow-up:Wait for acknowledgement:session',
      'publication-handoff:Publish prepared revision:human', 'publication-handoff:Publish prepared revision:session',
      'publication-handoff:Re-prepare or withdraw:group', 'publication-handoff:Re-prepare or withdraw:session',
    ])
  }, 600_000)
})

describe('P7: notice actions', () => {
  const CASES = 200
  /** New notification rows the real `notify` writes with a fresh key, on a copy of the database. */
  function notifyWrites(taskId: string, revision: number): number {
    const copy = Database.deserialize(db().serialize())
    try {
      const mail = new MailboxStore(copy)
      const assignments = new AssignmentStore(copy, mail)
      const notices = new TaskNotices(copy, mail, assignments, new TaskAcknowledgements(copy))
      const count = () => (copy.prepare('SELECT COUNT(*) AS n FROM team_task_notifications').get() as { n: number }).n
      const before = count()
      const task = tasks().store.get(taskId)!
      const row = tasks().store.revisions(taskId).find(entry => entry.revision === revision)!
      notices.notify(task, row, { sender: { actor: { kind: 'human', sessionId: null }, fromGroup: null, originPath: b.world.repo }, requestKey: `fresh-${crypto.randomUUID()}`, sessionExists: () => true })
      const written = count() - before
      assignments.close()
      return written
    } finally {
      copy.close()
    }
  }

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Acknowledgement without any delivery needs no notice
  test('P7: seed 0x0A11CE07, 200 cases — suppression over every history (P7a) and notice parity with the real notify (P7b)', async () => {
    const random = mulberry32(0x0A11CE07)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const counts = { suppressed: 0, parity: 0, offered: 0, laterFailedBehindReach: 0, ackWithoutDelivery: 0 }
    for (let index = 0; index < propertyCases(CASES); index++) {
      reviveAll()
      const taskId = await b.task()
      b.claim(taskId)
      const forced = index === 0
      const handoff = await b.request(taskId, forced ? false : random() < 0.5)
      const revision = await b.publish(taskId, handoff.id)
      const history: string[] = []
      let reachedBeforeFailed = false
      if (forced) {
        // Publish without notify → task_get → acknowledge with no delivery.
        await b.bench.taskService.get({ kind: 'agent', sessionId: 'dev' }, taskId)
        await b.acknowledge(taskId, 'dev', revision)
        history.push('ack-without-delivery')
      } else {
        for (let event = Math.floor(random() * 6); event > 0; event--) {
          const latest = tasks().store.get(taskId)!.revision
          const kind = pick(['notice', 'notice', 'notice', 'later', 'mail', 'ack', 'archive', 'close'] as const)
          if (kind === 'notice' || kind === 'later') {
            if (kind === 'later' && latest === revision) await tasks().publish(b.bench.human, taskId, { direction: `Later ${index}`, rationale: 'more', notify: false, requestKey: `later-${index}` })
            const state = pick(NOTICES)
            const at = kind === 'later' ? tasks().store.get(taskId)!.revision : revision
            if (state === 'failed' && history.some(entry => /^notice:(queued|delivered|uncertain)/.test(entry))) reachedBeforeFailed = true
            try { b.notice(taskId, at, state) } catch { /* nobody holds it */ }
            history.push(`notice:${state}@${at - revision}`)
          } else if (kind === 'mail') {
            const delivered = random() < 0.6
            b.taskMail(taskId, 'dev', random() < 0.7 ? revision : latest, delivered)
            history.push(`mail:${delivered}`)
          } else if (kind === 'ack') {
            if (live('dev')) await swallow(() => b.acknowledge(taskId, 'dev', random() < 0.7 ? revision : latest))
            history.push('ack')
          } else if (kind === 'archive') {
            b.gone('dev')
            history.push('archive')
          } else {
            await swallow(() => tasks().setStatus(b.bench.human, taskId, 'done'))
            history.push('close')
          }
        }
      }
      const stored: TaskHandoff = tasks().handoffs.store.get(handoff.id)!
      const facts = followUpFacts({ db: db(), mail: b.bench.mail, notices: tasks().store.notices!, acknowledgements: tasks().store.acknowledgements, live }, stored, tasks().store.get(taskId)!)
      const phase = handoffPhase(facts)
      const item = b.items().find(entry => entry.id === `publication-follow-up:${handoff.id}`) ?? null
      const action = item?.nextAction ?? null
      const offered = action === 'Notify' || action === 'Retry notification'
      const label = [index, history]
      if (facts.taskClosed || (facts.acknowledgedRevision ?? 0) >= revision) {
        counts.suppressed++
        if ((facts.deliveredRevision ?? 0) < revision && (facts.acknowledgedRevision ?? 0) >= revision) counts.ackWithoutDelivery++
        expect([label, ['task-closed', 'acknowledged'].includes(phase), item]).toEqual([label, true, null])
      } else if (facts.claimant?.live) {
        counts.parity++
        const writes = notifyWrites(taskId, revision)
        if (offered) counts.offered++
        if (reachedBeforeFailed && writes === 0) counts.laterFailedBehindReach++
        expect([label, phase, offered]).toEqual([label, phase, writes >= 1])
        if (writes === 0) expect([label, ['delivered-awaiting-ack', 'notice-uncertain', 'notice-queued'].includes(phase)]).toEqual([label, true])
      }
    }
    // The generator reached each kind of history the property names.
    expect(counts.suppressed).toBeGreaterThan(0)
    expect(counts.ackWithoutDelivery).toBeGreaterThan(0)
    expect(counts.parity).toBeGreaterThan(0)
    expect(counts.offered).toBeGreaterThan(0)
    expect(counts.laterFailedBehindReach).toBeGreaterThan(0)
  }, 600_000)
})
