// Tables W and F (owner-publication-handoff design "Table W", "Table F";
// tasks 8.1, 8.2). Each table is committed below as rows of independent
// predicates with the item they expect; the completeness tests expand each
// table's axes (pending: state × owner liveness × requester liveness;
// published: task status × claimant × acknowledgement × delivery × every
// notice list of up to two × execution ownership; ended: every ended state;
// F: submitter × claimant × execution × task owner) and require exactly one
// row per tuple and that row's item from the real sources. The history rows
// drive the real stores: publications, `TaskNotices` notices moved to their
// state, ordinary task mail, `task_acknowledge`, archival and a real close.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HANDOFF_STATES, type HandoffFollowUpFacts, type HandoffNoticeState, type TaskHandoff } from '../../shared/taskHandoffs'
import type { AttentionItem } from '../../shared/teamWorkspace'
import { handoffAttentionItems, handoffFollowUpItems } from '../team/handoffAttention'
import { fixesOwner, type FixesFacts } from '../team/attentionAcceptance'
import { WorkspaceRead } from '../team/workspaceRead'
import { createHandoffAttentionBench, type HandoffAttentionBench } from './helpers/handoffAttentionBench'
import { shown, W_PENDING, W_PUBLISHED, type PendingAxes, type PublishedAxes } from './helpers/handoffWTable'

const handoff = (state: TaskHandoff['state'], extra: Partial<TaskHandoff> = {}): TaskHandoff => ({
  id: 'handoff-1', teamId: 'team', taskId: 'task-1', baseRevision: 1, baseContractHash: null, direction: 'v2', acceptance: null, contract: null,
  rationale: 'why', notify: false, payloadHash: 'h', baseCommit: null, evidenceRefs: [], requesterSession: 'lead', requesterGroup: 'leads',
  requestKey: 'k', state, stateReason: null, stateActor: null, publishedRevision: state === 'published' ? 2 : null, publishedPayloadHash: null,
  supersededBy: null, createdAt: '', updatedAt: '', ...extra,
})

const ENDED = HANDOFF_STATES.filter(state => !['open', 'stale', 'published'].includes(state))

function pendingTuples(): PendingAxes[] {
  return (['open', 'stale'] as const).flatMap(state => (['live', 'none', 'gone'] as const)
    .flatMap(owner => (['live', 'gone'] as const).map(requester => ({ state, owner, requester }))))
}
function pendingItems(t: PendingAxes): AttentionItem[] {
  return handoffAttentionItems([{
    handoff: handoff(t.state), taskTitle: 'Export', requesterName: 'lead',
    liveOwner: t.owner === 'live' ? { sessionId: 'owner', name: 'Owner' } : null, requesterLive: t.requester === 'live', taskRevision: 2,
  }])
}

const NOTICE_STATES: HandoffNoticeState[] = ['queued', 'delivered', 'uncertain', 'failed']
const noticeLists = (): HandoffNoticeState[][] => [[], ...NOTICE_STATES.map(state => [state]), ...NOTICE_STATES.flatMap(a => NOTICE_STATES.map(b => [a, b]))]
/** Every published tuple a legal history can produce: a delivered notice implies a delivered revision. */
function publishedTuples(): PublishedAxes[] {
  const out: PublishedAxes[] = []
  for (const closed of [false, true]) for (const claimant of ['none', 'live', 'gone'] as const) for (const acked of [false, true])
    for (const delivered of [false, true]) for (const notices of noticeLists()) for (const owns of [false, true]) {
      if (claimant === 'none' && (acked || delivered || notices.length > 0)) continue
      if (notices.includes('delivered') && !delivered) continue
      out.push({ closed, claimant, acked, delivered, notices, owns })
    }
  return out
}
const factsOf = (t: PublishedAxes): HandoffFollowUpFacts => ({
  publishedRevision: 2, taskClosed: t.closed,
  claimant: t.claimant === 'none' ? null : { sessionId: 'dev', live: t.claimant === 'live' },
  deliveredRevision: t.claimant === 'none' ? null : t.delivered ? 2 : 1,
  acknowledgedRevision: t.claimant === 'none' ? null : t.acked ? 2 : 1,
  notices: t.notices.map((state, index) => ({ state, messageId: `m${index}` })),
})
const followUps = (t: PublishedAxes, state: TaskHandoff['state'] = 'published') =>
  handoffFollowUpItems([{ handoff: handoff(state), taskTitle: 'Export', facts: factsOf(t), executionOwns: t.owns, nameOf: id => id }])

describe('Table W completeness', () => {
  test('every pending tuple matches exactly one of W1–W4 and yields its item', () => {
    for (const tuple of pendingTuples()) {
      const rows = W_PENDING.filter(row => row.match(tuple))
      expect([tuple, rows.map(row => row.id).length]).toEqual([tuple, 1])
      expect([tuple, rows[0]!.id, shown(pendingItems(tuple))]).toEqual([tuple, rows[0]!.id, [rows[0]!.expect]])
    }
    expect(new Set(pendingTuples().map(tuple => W_PENDING.find(row => row.match(tuple))!.id))).toEqual(new Set(W_PENDING.map(row => row.id)))
  })

  test("every published tuple matches exactly one of W5–W12d and yields its item, in handoffPhase's order", () => {
    const reached = new Set<string>()
    for (const tuple of publishedTuples()) {
      const rows = W_PUBLISHED.filter(row => row.match(tuple)).map(row => row.id)
      expect([tuple, rows.length]).toEqual([tuple, 1])
      const row = W_PUBLISHED.find(entry => entry.id === rows[0])!
      reached.add(row.id)
      expect([tuple, row.id, shown(followUps(tuple))]).toEqual([tuple, row.id, row.expect === null ? [] : [row.expect]])
    }
    expect([...reached].sort()).toEqual(W_PUBLISHED.map(row => row.id).sort())
  })

  test('W13: every ended handoff yields no item from either source, whatever its facts', () => {
    for (const state of ENDED) {
      for (const tuple of pendingTuples()) {
        expect(handoffAttentionItems([{ handoff: handoff(state), taskTitle: 'x', requesterName: 'lead', liveOwner: null, requesterLive: tuple.requester === 'live', taskRevision: 2 }])).toEqual([])
      }
      for (const tuple of publishedTuples()) expect([state, followUps(tuple, state)]).toEqual([state, []])
    }
  })

  test('W9 links the uncertain message; the other follow-up rows link the task with its handoff anchor', () => {
    const base = { closed: false, claimant: 'live' as const, acked: false, delivered: false, owns: false }
    expect(followUps({ ...base, notices: ['failed', 'uncertain'] })[0]!.link).toEqual({ kind: 'message', id: 'm1' })
    expect(followUps({ ...base, notices: ['failed'] })[0]!.link).toEqual({ kind: 'task', id: 'task-1', handoffId: 'handoff-1' })
    expect(pendingItems({ state: 'open', owner: 'none', requester: 'live' })[0]!.link).toEqual({ kind: 'task', id: 'task-1', handoffId: 'handoff-1' })
  })
})

describe('Table W through the real stores', () => {
  let b: HandoffAttentionBench
  beforeAll(async () => { b = await createHandoffAttentionBench() })
  afterAll(() => b.close())
  const itemsOf = (taskId: string, owned = false) => b.items(id => owned && id === taskId).filter(item => item.impact.taskId === taskId)
  const row = (taskId: string, owned = false) => shown(itemsOf(taskId, owned))
  const published = async (notify = false) => {
    const taskId = await b.task()
    b.claim(taskId)
    const handoff = await b.request(taskId, notify)
    const revision = await b.publish(taskId, handoff.id)
    return { taskId, handoff, revision }
  }

  // @covers: team-workspace › The attention queue lists pending publication handoffs › A live owner's handoff is an agent wait
  // @covers: team-workspace › The attention queue lists pending publication handoffs › An archived owner hands the handoff to the human
  test('W1 and W2: a live agent owner publishes; an archived owner or none hands it to the human', async () => {
    const owned = await b.task('lead2')
    await b.request(owned)
    expect(row(owned)).toEqual([W_PENDING[0]!.expect])
    b.gone('lead2')
    expect(row(owned)).toEqual([W_PENDING[1]!.expect])
    const ownerless = await b.task()
    await b.request(ownerless)
    expect(row(ownerless)).toEqual([W_PENDING[1]!.expect])
  })

  // @covers: team-workspace › The attention queue lists pending publication handoffs › A stale handoff goes back to its requester
  test('W3 and W4: a stale handoff waits on its live requester, then on its group once the requester is gone', async () => {
    const taskId = await b.task()
    const handoff = await b.request(taskId, false, 'lead')
    await b.bench.taskService.publish(b.bench.human, taskId, { direction: 'Mine', rationale: 'own edit', notify: false, requestKey: 'own' })
    expect(b.bench.taskService.handoffs.store.get(handoff.id)!.state).toBe('stale')
    expect(itemsOf(taskId).map(item => item.owner)).toEqual([{ kind: 'session', id: 'lead', label: 'lead' }])
    expect(row(taskId)).toEqual([W_PENDING[2]!.expect])
    expect(itemsOf(taskId)[0]!.cause).toContain('revision 2 was published since')
    b.gone('lead')
    expect(itemsOf(taskId).map(item => item.owner)).toEqual([{ kind: 'group', id: 'leads', label: 'leads' }])
    expect(row(taskId)).toEqual([W_PENDING[3]!.expect])
    b.revive('lead')
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Plain publication of a handoff
  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Notice failure needs the human
  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Acknowledgement after a failed notice
  test('W11 then W10 then W6: published without notify offers Notify; a failed notice Retry notification; an acknowledgement after it ends the follow-up', async () => {
    const { taskId, revision } = await published()
    expect(row(taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W11')!.expect])
    b.notice(taskId, revision, 'failed')
    expect(row(taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W10')!.expect])
    await b.acknowledge(taskId, 'dev', revision)
    expect(row(taskId)).toEqual([])
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Delivery after a failed notice waits for the holder
  test('W12d: a failed notice followed by ordinary task mail delivering the revision is the holder\'s wait, with no Retry notification', async () => {
    const { taskId, revision } = await published()
    b.notice(taskId, revision, 'failed')
    b.taskMail(taskId, 'dev', revision)
    const items = itemsOf(taskId)
    expect(shown(items)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W12d')!.expect])
    expect(items[0]!.owner).toEqual({ kind: 'session', id: 'dev', label: 'dev' })
    expect(items[0]!.cause).toContain(`delivered revision ${revision}, acknowledged 1`)
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › An uncertain notice goes to the Mailbox
  test('W9 and W12: an uncertain notice goes to the Mailbox linked to its message; a queued one is the holder\'s wait', async () => {
    const uncertain = await published()
    const messageId = b.notice(uncertain.taskId, uncertain.revision, 'uncertain')
    expect(row(uncertain.taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W9')!.expect])
    expect(itemsOf(uncertain.taskId)[0]!.link).toEqual({ kind: 'message', id: messageId })
    // Every notice at or past the revision counts, not only the newest: a
    // later failed notice leaves the uncertain one to resolve (W9, not W10).
    b.notice(uncertain.taskId, uncertain.revision, 'failed')
    expect(row(uncertain.taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W9')!.expect])
    expect(itemsOf(uncertain.taskId)[0]!.link).toEqual({ kind: 'message', id: messageId })
    const queued = await published(true)
    expect(row(queued.taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W12')!.expect])
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Waiting for the holder's acknowledgement
  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Acknowledgement clears the follow-up
  test("W12d then W6: a delivered notice waits for the holder's acknowledgement, naming the delivered and acknowledged revisions; the acknowledgement clears it", async () => {
    const { taskId, revision } = await published()
    b.notice(taskId, revision, 'delivered')
    expect(row(taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W12d')!.expect])
    expect(itemsOf(taskId)[0]!.cause).toContain(`delivered revision ${revision}, acknowledged 1`)
    await b.acknowledge(taskId, 'dev', revision)
    expect(row(taskId)).toEqual([])
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Acknowledgement without any delivery needs no notice
  test('W6: published without notify, read and acknowledged with no delivery, offers neither Notify nor Retry notification', async () => {
    const { taskId, revision } = await published()
    expect(row(taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W11')!.expect])
    await b.acknowledge(taskId, 'dev', revision)
    expect(row(taskId)).toEqual([])
    expect(b.bench.taskService.store.notices!.deliveredRevision(taskId, 'dev')).toBe(1)
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › No session holds the task
  test('W7 and W8: with the claimant gone, Kawai dispatches an execution-owned task, else the human hands it off', async () => {
    const { taskId } = await published()
    b.gone('dev')
    expect(row(taskId, true)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W7')!.expect])
    expect(row(taskId)).toEqual([W_PUBLISHED.find(entry => entry.id === 'W8')!.expect])
    b.revive('dev')
  })

  // @covers: team-workspace › A published handoff stays visible until its holder acknowledges › Closing the task ends the follow-up
  // @covers: team-workspace › The attention queue lists pending publication handoffs › A disposition clears the item
  test('W5 and W13: closing the task without any acknowledgement ends the follow-up; an ended handoff has no item', async () => {
    const { taskId } = await published()
    expect(row(taskId)).toHaveLength(1)
    await b.bench.taskService.setStatus(b.bench.human, taskId, 'done')
    expect(row(taskId)).toEqual([])
    const declined = await b.task()
    const handoff = await b.request(declined)
    await b.bench.taskService.handoffs.settle(b.bench.human, handoff.id, 'decline', 'not now')
    expect(row(declined)).toEqual([])
  })
})

// Table F (verbatim: Id, Submitter, Live claimant, Execution owns, Task owner → Owner, Needs human, Next action).
type FAxes = { submitter: 'live' | 'gone'; claimant: boolean; owns: boolean; owner: 'live' | 'none' }
const F_ROWS: Array<{ id: string; match: (t: FAxes) => boolean; owner: string; needsHuman: boolean; action: string }> = [
  { id: 'F1', match: t => t.submitter === 'live', owner: 'submitter', needsHuman: false, action: 'Wait for fixes' },
  { id: 'F2', match: t => t.submitter === 'gone' && t.claimant, owner: 'claimant', needsHuman: false, action: 'Wait for fixes' },
  { id: 'F3', match: t => t.submitter === 'gone' && !t.claimant && t.owns, owner: 'Kawai', needsHuman: false, action: 'Wait for Kawai to dispatch the fix' },
  { id: 'F4', match: t => t.submitter === 'gone' && !t.claimant && !t.owns && t.owner === 'live', owner: 'task owner', needsHuman: false, action: 'Hand off for fixes' },
  { id: 'F5', match: t => t.submitter === 'gone' && !t.claimant && !t.owns && t.owner === 'none', owner: 'human', needsHuman: true, action: 'Hand off for fixes' },
]

describe('Table F', () => {
  const ownerLabel: Record<string, string> = { submitter: 'Dev', claimant: 'Claimant', Kawai: 'Kawai', 'task owner': 'Owner', human: 'Human' }
  const tuples = (): FAxes[] => (['live', 'gone'] as const).flatMap(submitter => [true, false].flatMap(claimant => [true, false]
    .flatMap(owns => (['live', 'none'] as const).map(owner => ({ submitter, claimant, owns, owner })))))
  const facts = (t: FAxes): FixesFacts => ({
    submitterLive: t.submitter === 'live', liveClaimant: t.claimant ? { sessionId: 'claimant', name: 'Claimant' } : null,
    executionOwns: t.owns, liveOwner: t.owner === 'live' ? { sessionId: 'owner', name: 'Owner' } : null,
  })

  // @covers: team-workspace › The attention queue lists what needs a human or is waiting on an agent › Fixes of a gone submitter under a running execution wait for Kawai
  // @covers: team-workspace › The attention queue lists what needs a human or is waiting on an agent › Fixes of a gone submitter outside an execution need a handoff
  // @covers: team-workspace › The attention queue lists what needs a human or is waiting on an agent › A live holder still owns the wait
  test('F1–F5: every tuple matches exactly one row; F2–F5 name the submitter archived and F3–F5 no session running the task', () => {
    const reached = new Set<string>()
    for (const tuple of tuples()) {
      const rows = F_ROWS.filter(row => row.match(tuple))
      expect([tuple, rows.length]).toEqual([tuple, 1])
      const row = rows[0]!
      reached.add(row.id)
      const item = fixesOwner({ submitter: 'Dev', submitterId: 'chat-dev', fixes: facts(tuple) })
      expect([row.id, item.owner.label, item.requiresHuman, item.nextAction]).toEqual([row.id, ownerLabel[row.owner], row.needsHuman, row.action])
      expect([row.id, item.cause.includes('the submitter Dev is archived')]).toEqual([row.id, row.id !== 'F1'])
      expect([row.id, item.cause.includes('no session is running the task')]).toEqual([row.id, ['F3', 'F4', 'F5'].includes(row.id)])
    }
    expect([...reached].sort()).toEqual(F_ROWS.map(row => row.id).sort())
  })

  test('a human submitter and a result without Table F facts keep the submitter wait (F1, the existing rows)', () => {
    expect(fixesOwner({ submitter: 'Human', submitterId: null, fixes: facts({ submitter: 'gone', claimant: false, owns: false, owner: 'none' }) }))
      .toMatchObject({ owner: { kind: 'human', label: 'Human' }, requiresHuman: false, nextAction: 'Wait for fixes' })
    expect(fixesOwner({ submitter: 'Dev', submitterId: 'chat-dev' })).toMatchObject({ owner: { kind: 'session', id: 'chat-dev' }, nextAction: 'Wait for fixes' })
  })
})

describe('Table F through WorkspaceRead and the handoff liveness predicate', () => {
  let b: HandoffAttentionBench
  beforeAll(async () => { b = await createHandoffAttentionBench('kawai-handoff-fixes-') })
  afterAll(() => b.close())
  /** The snapshot's fixes-requested item for a failing result by `dev`, with the task's claimant, owner and execution ownership. */
  function fixesItem(claimedBy: string | null, owner: string | null, owned: boolean): AttentionItem {
    const task = {
      id: 'task-f', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, ownerSession: owner, parentId: null,
      worktree: null, openspecChange: null, revision: 1, direction: 'Do it', acceptance: null, createdAt: '', updatedAt: '', participants: [],
      assignment: claimedBy ? { claimedBy, state: 'claimed', targetKind: 'group', targetId: 'middle-devs' } : null,
      outstandingResult: { id: 'r-f', needsReevaluation: false, accepted: false, reviewVerdict: 'fail' },
    }
    const records = [...b.bench.records.values()]
    const manager = {
      tasks: {
        store: {
          list: () => [task], get: () => task, acknowledgements: { highest: () => null },
          results: { get: () => ({ id: 'r-f', submittedBy: { kind: 'agent', sessionId: 'dev' } }), outstandingSince: () => [], submittedBy: () => false },
        },
        // The production liveness: the session record present, neither archived nor context-exhausted.
        handoffs: b.bench.taskService.handoffs,
      },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } }, waitingFor: () => ({}), teamRecords: () => records,
      directory: { list: () => [] }, getPendingRequests: () => [], teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}), teamApprovalDefault: () => null, turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [],
      outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
      results: { ownedByExecution: () => owned },
    }
    const snapshot = new WorkspaceRead(manager as never).snapshot({ teamId: 'team', groupsRoot: '/nonexistent-kawai-groups-root' } as never)
    return snapshot.attention.find(item => item.kind === 'fixes-requested')!
  }
  const summary = (item: AttentionItem) => ({ owner: item.owner.kind, id: item.owner.id, needsHuman: item.requiresHuman, action: item.nextAction })

  test('F1–F5 read the session records: archival and context exhaustion make a party gone', () => {
    expect(summary(fixesItem(null, null, false))).toEqual({ owner: 'session', id: 'dev', needsHuman: false, action: 'Wait for fixes' })
    b.gone('dev')
    expect(summary(fixesItem('lead2', null, false))).toEqual({ owner: 'session', id: 'lead2', needsHuman: false, action: 'Wait for fixes' })
    expect(summary(fixesItem(null, null, true))).toEqual({ owner: 'kawai', id: null, needsHuman: false, action: 'Wait for Kawai to dispatch the fix' })
    expect(summary(fixesItem(null, 'lead', false))).toEqual({ owner: 'session', id: 'lead', needsHuman: false, action: 'Hand off for fixes' })
    b.bench.records.set('lead', { ...b.bench.records.get('lead')!, contextExhausted: { at: new Date().toISOString(), reason: 'prompt_too_long' } })
    b.gone('lead2')
    expect(summary(fixesItem('lead2', 'lead', false))).toEqual({ owner: 'human', id: null, needsHuman: true, action: 'Hand off for fixes' })
    expect(fixesItem(null, null, false).cause).toBe('Review of the result submitted by dev requested fixes; the submitter dev is archived and no session is running the task')
  })
})
