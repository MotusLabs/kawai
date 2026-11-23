import { expect, test } from 'bun:test'
import { renderContract } from '../../shared/implementationContract'
import { preparedKey } from '../../shared/taskHandoffs'
import type { ServerMessage } from '../../shared/types'
import { PREPARED } from './helpers/decisionPublicationBench'
import {
  askInput, beginAfterCheck, beginIndependent, bind, linkedDraft, ordinary, prepare, prepared, type BindingAnswer, type PublicationRuntime,
} from './helpers/decisionPublicationCommands'
import { publicationRuntime, waitFor } from './helpers/decisionPublicationRuntime'

const COMPETITORS = ['same approval', 'new approval', 'answer', 'prepared', 'linked draft', 'ordinary'] as const
type Competitor = (typeof COMPETITORS)[number]
type RoutedResult = Extract<ServerMessage, { type: 'team-plan-result' | 'team-task-result' }>

async function race(competitor: Competitor, combinedFirst: boolean) {
  const runtime = await publicationRuntime()
  const { manager, routed, snapshot, task } = runtime
  let resume = () => {}
  try {
    const handoff = await prepare(runtime)
    const { approve, answer, read } = await bind(runtime, handoff)
    const independent = competitor === 'linked draft' ? await linkedDraft(runtime, handoff)
      : competitor === 'prepared' ? prepared(runtime, handoff) : ordinary(runtime)
    const secondApproval = { ...approve, requestId: 'second-click',
      commandId: competitor === 'same approval' ? approve.commandId : 'different-command' }
    const concurrent = (): Promise<RoutedResult> => {
      if (competitor === 'answer') return routed('team-plan-result', answer)
      if (competitor === 'same approval' || competitor === 'new approval') {
        return routed('team-plan-result', secondApproval)
      }
      return routed('team-task-result', independent)
    }
    const baseline = snapshot()
    const announced: string[] = []
    const unsubscribe = manager.decisions!.onDecided((_card, decision) => { announced.push(decision.id) })
    let losingReply
    let winningReply
    let afterWinner
    if (combinedFirst) {
      const pending = competitor === 'same approval' || competitor === 'new approval'
        ? await beginAfterCheck(runtime, secondApproval)
        : await beginIndependent(runtime, competitor === 'answer' ? 'answer' : 'publish', concurrent)
      resume = pending.resume
      winningReply = await routed('team-plan-result', approve)
      await runtime.settleDelivery()
      afterWinner = snapshot()
      resume()
      losingReply = await pending.result
    } else {
      const pending = await beginAfterCheck(runtime, approve)
      resume = pending.resume
      winningReply = await concurrent()
      await runtime.settleDelivery()
      afterWinner = snapshot()
      resume()
      losingReply = await pending.result
    }
    expect(winningReply.error).toBeUndefined()
    expect(snapshot()).toEqual(afterWinner)
    const view = await read()
    const combined = combinedFirst || competitor === 'same approval' || competitor === 'new approval'
    expect(view.decisions).toHaveLength(combined || competitor === 'answer' ? 1 : 0)
    expect(announced).toEqual(view.decisions.map(decision => decision.id))
    unsubscribe()
    expect(snapshot().team_task_revisions).toHaveLength(baseline.team_task_revisions!.length + (!combined && competitor === 'answer' ? 0 : 1))
    const receipt = view.publication?.receipt
    if (combined) {
      expect(receipt).toMatchObject({ taskId: task.id, handoffId: handoff.id, baseRevision: 1, publishedRevision: 2 })
      expect(manager.tasks.store.revisions(task.id)[1]).toMatchObject({ direction: PREPARED.direction, author: { kind: 'human' } })
      expect(receipt?.noticeMessageIds).toHaveLength(1)
      expect(manager.mailbox.store.get(receipt!.wakeupMessageId!)).toMatchObject({ taskId: null, toId: runtime.lead })
      if (competitor === 'same approval') expect(losingReply).toMatchObject({ publication: receipt, replayed: true })
      else if (combinedFirst && competitor === 'prepared') expect(losingReply).toMatchObject({ revision: 2, replay: true })
      else expect(losingReply.error).toBeDefined()
      const retry = await routed('team-plan-result', { ...approve, requestId: 'exact-replay', commandId: receipt!.commandId })
      expect(retry).toMatchObject({ publication: receipt, replayed: true })
    } else {
      expect(receipt).toBeNull()
      expect(losingReply).toMatchObject({ reason: competitor === 'answer' ? 'state' : 'stale' })
      expect(manager.tasks.handoffs.store.get(handoff.id)?.state)
        .toBe(competitor === 'answer' ? 'open' : competitor === 'ordinary' ? 'stale' : 'published')
    }
    expect(snapshot()).toEqual(afterWinner)
    const current = manager.tasks.store.get(task.id)!.revision
    expect(await routed('team-task-result', { ...ordinary(runtime, task.id, current), requestId: 'later', requestKey: 'later-ordinary' }))
      .toMatchObject({ revision: current + 1, replay: false })
    expect((await read()).publication?.receipt).toEqual(receipt)
  } finally {
    resume()
    await runtime.teardown()
  }
}

// @covers: plan-decisions › One approval intent has one durable receipt › Competing actions have only their own effects
// @covers: plan-decisions › One approval intent has one durable receipt › Reuse of a command id compares the action and input
test('W07 each competing command can win after the combined command checked its review', async () => {
  for (const competitor of COMPETITORS) await race(competitor, false)
})

test('W07 the combined write can win after each competing command reaches its writer', async () => {
  for (const competitor of COMPETITORS) await race(competitor, true)
})

// @covers: plan-decisions › A publication question binds one prepared handoff › A retry recovers the same binding
// @covers: plan-decisions › One approval intent has one durable receipt › Restart distinguishes uncommitted and committed intent
test('W08 boot recovers a lost original ask after focus moves and refuses every unauthorized replay', async () => {
  const runtime = await publicationRuntime()
  try {
    const handoff = await prepare(runtime)
    const ask = askInput(handoff)
    const before = runtime.snapshot()
    runtime.db.db.exec(`CREATE TEMP TRIGGER lost_bind AFTER INSERT ON plan_decision_publications
      BEGIN SELECT RAISE(ABORT, 'binding rolls back here'); END`)
    await expect(runtime.leadTool('decision_ask', ask)).rejects.toThrow('binding rolls back here')
    expect(runtime.snapshot()).toEqual(before)
    await runtime.reopen()
    expect(runtime.snapshot()).toEqual(before)
    // Ignore the response and recover the binding identity independently from the committed row.
    await runtime.leadTool('decision_ask', ask)
    const original = runtime.db.db.query<{ card_id: string; binding_hash: string }, [string]>(
      'SELECT card_id, binding_hash FROM plan_decision_publications WHERE handoff_id = ?',
    ).get(handoff.id)!
    await runtime.startHolder()
    for (const focus of ['unlinked', 'sibling', 'other-plan'] as const) {
      const moved = await runtime.sendFocus(focus)
      const settled = runtime.snapshot()
      const replayed = await runtime.leadTool<BindingAnswer>('decision_ask', ask)
      expect(replayed).toMatchObject({ card_id: original.card_id, replayed: true, publication: { handoff_id: handoff.id, task_id: runtime.task.id } })
      expect(runtime.db.getChatSession(runtime.lead)?.taskId).toBe(moved.other.id)
      expect(runtime.snapshot()).toEqual(settled)
    }
    await runtime.leadTool('task_settle_publication', { handoff_id: handoff.id, action: 'withdraw', reason: 'End after asking' })
    const ended = runtime.snapshot()
    await runtime.reopen()
    expect(await runtime.leadTool('decision_ask', ask)).toMatchObject({ card_id: original.card_id, replayed: true })
    expect(runtime.snapshot()).toEqual(ended)
    const decisions = runtime.manager.decisions!
    const record = decisions.deps.getSession(runtime.lead)!
    const originalRead = decisions.deps.getSession
    const refusals = [
      [() => runtime.leadTool('decision_ask', { ...ask, plan_id: 'different-plan' }), 'plan_id'],
      [() => runtime.holderTool('decision_ask', ask), 'original requester'],
      [() => runtime.leadTool('decision_ask', { ...ask, question: 'Changed after reboot?' }), 'different question'],
    ] as const
    await runtime.startHolder()
    for (const [attempt, reason] of refusals) await expect(attempt()).rejects.toThrow(reason)
    decisions.deps.getSession = id => id === runtime.lead ? { ...record, groupId: 'middle-devs' } : originalRead(id)
    await expect(runtime.leadTool('decision_ask', ask)).rejects.toThrow('routes to the Lead')
    decisions.deps.getSession = originalRead
    const db = runtime.db.db
    const route = db.query<{ content_json: string }, [string, number]>('SELECT content_json FROM plan_revisions WHERE plan_id = ? AND revision = ?')
      .get(runtime.plan.planId, runtime.approved.revision)!
    const writeRoute = db.prepare('UPDATE plan_revisions SET content_json = ? WHERE plan_id = ? AND revision = ?')
    writeRoute.run('unreadable current role', runtime.plan.planId, runtime.approved.revision)
    const dirty = runtime.snapshot()
    await expect(runtime.leadTool('decision_ask', ask)).rejects.toThrow('missing or unreadable')
    expect(runtime.snapshot()).toEqual(dirty)
    writeRoute.run(route.content_json, runtime.plan.planId, runtime.approved.revision)
    expect(runtime.snapshot()).toEqual(ended)
  } finally { await runtime.teardown() }
})

export const WRITE_FAULTS: ReadonlyArray<readonly [string, string]> = [
  ['revision', 'AFTER INSERT ON team_task_revisions WHEN NEW.revision = 2'],
  ['association', 'AFTER UPDATE OF handoff_id ON team_task_revisions WHEN NEW.handoff_id IS NOT NULL'],
  ['handoff event', "AFTER INSERT ON team_task_handoff_events WHEN NEW.to_state = 'published'"],
  ['wakeup', "AFTER INSERT ON team_task_handoff_wakeups WHEN NEW.transition = 'published'"],
  ['direct notice', 'AFTER INSERT ON team_task_notifications'],
  ['finding remap', "AFTER INSERT ON team_task_finding_events WHEN NEW.kind = 'remapped'"],
  ['decision', 'AFTER INSERT ON plan_decisions'],
  ['receipt', 'AFTER UPDATE OF decision_id ON plan_decision_publications WHEN NEW.decision_id IS NOT NULL'],
]

function seedFinding(runtime: PublicationRuntime) {
  const { manager, task, holder, lead, feature } = runtime
  const submittedBy = { kind: 'agent', sessionId: holder } as const
  const result = manager.tasks.store.results.insert({
    teamId: task.teamId, taskId: task.id, summary: 'Review the existing output', commit: null, diff: 'fixture-diff',
    worktree: feature, tests: [], limitations: null, taskRevision: 1, submittedBy,
  })
  const identity = manager.tasks.store.revisions(task.id)[0]!.identity!
  manager.tasks.store.findings.insertSubmission({
    teamId: task.teamId, taskId: task.id, resultId: result.id, handoffId: null, kind: 'review',
    verdict: 'fail', notes: '', author: { kind: 'agent', sessionId: lead }, counted: true, contractIdentity: identity, ledgerSeq: 1,
    items: [{
      findingId: 'F1', itemKind: 'finding', level: 'P1', clause: `${identity} › A1`, clauseId: 'A1',
      evidence: 'The first row is data.', impact: 'Readers misinterpret data.', reproduction: null,
      locus: '', class: 'accepted', reason: null, disposition: null, regressed: false,
    }],
  })
}

// @covers: plan-decisions › One approval intent has one durable receipt › Restart distinguishes uncommitted and committed intent
test('W08 each interrupted approval rolls back and boot reuses only the committed notice and receipt', async () => {
  const runtime = await publicationRuntime()
  try {
    const { task, teamPath, plan, route, frames, snapshot, routed, holder, lead } = runtime
    seedFinding(runtime)
    const contract = renderContract({ ...task.contract!, verification: [{ id: 'V1', text: 'Inspect both the header and body.' }] })
    const handoff = await prepare(runtime, task.id, 1, PREPARED.requestKey, contract)
    const { approve, read } = await bind(runtime, handoff)
    route({ type: 'team-plan-open', teamPath, planId: plan.planId })
    route({ type: 'team-task-open', teamPath, taskId: task.id })
    route({ type: 'team-mailbox-open', teamPath })
    const kinds = ['team-plan-detail', 'team-task-detail', 'team-mailbox-snapshot']
    await waitFor(() => kinds.every(kind => frames.some(frame => frame.type === kind)), 'the observed plan, task and mailbox')
    const before = snapshot()
    for (const [label, boundary] of WRITE_FAULTS) {
      const db = runtime.db.db
      const next = frames.length
      const observed: string[] = []
      const stop = runtime.manager.mailbox.store.subscribe((_team, mail) => { if (mail) observed.push(mail.id) })
      db.exec(`CREATE TEMP TRIGGER interrupt_publication ${boundary} BEGIN SELECT RAISE(ABORT, 'interrupted ${label}'); END`)
      try {
        const failed = await routed('team-plan-result', { ...approve, requestId: label })
        expect([label, failed.reason, failed.error]).toEqual([label, 'state', expect.stringContaining(`interrupted ${label}`)])
        expect(failed.publication).toBeUndefined()
        expect(snapshot()).toEqual(before)
        expect(observed).toEqual([])
        for (const frame of frames.slice(next)) {
          if (frame.type === 'team-task-detail') expect(frame.detail.task.revision).toBe(1)
          if (frame.type === 'team-plan-detail') {
            const card = frame.detail.decisions?.find(view => view.card.id === approve.cardId)
            expect(card?.publication?.receipt).toBeNull()
            expect(card?.decisions).toEqual([])
          }
          if (frame.type === 'team-mailbox-snapshot') {
            expect(frame.messages.filter(row => row.tags.includes('handoff-published') || row.tags.includes('task-revision'))).toEqual([])
          }
        }
      } finally {
        db.exec('DROP TRIGGER interrupt_publication')
        stop()
      }
    }
    await runtime.reopen()
    expect(snapshot()).toEqual(before)
    expect((await read()).publication?.receipt).toBeNull()
    await runtime.pauseDelivery()
    runtime.loseReply(approve.requestId)
    route(approve)
    let receipt = (await read()).publication?.receipt
    for (let reads = 0; !receipt && reads < 40; reads++) receipt = (await read()).publication?.receipt
    expect(receipt).toMatchObject({ taskId: task.id, handoffId: handoff.id, publishedRevision: 2, baseRevision: 1 })
    expect(frames.some(frame => 'requestId' in frame && frame.requestId === approve.requestId)).toBe(false)
    const [noticeId] = receipt!.noticeMessageIds
    const wakeupId = receipt!.wakeupMessageId!
    expect(runtime.manager.mailbox.store.get(noticeId!)).toMatchObject({ state: 'queued', toId: holder })
    expect(runtime.manager.mailbox.store.get(wakeupId)).toMatchObject({ state: 'queued', toId: lead })
    expect(runtime.manager.tasks.store.findings.events(task.id)).toMatchObject([{ kind: 'remapped', findingId: 'F1', clause: expect.stringContaining(' › A1') }])
    await runtime.reopen()
    await waitFor(() => [noticeId!, wakeupId].every(id => runtime.manager.mailbox.store.get(id)?.state === 'delivered'), 'the original messages after boot')
    expect(runtime.transcript(holder)).toContain(noticeId!)
    expect(runtime.transcript(lead)).toContain(wakeupId)
    expect(runtime.manager.tasks.store.acknowledgements.highest(task.id, holder)).toBeNull()
    const after = snapshot()
    expect(await routed('team-plan-result', { ...approve, requestId: 'recovered' })).toMatchObject({ publication: receipt, replayed: true })
    expect(await routed('team-task-result', prepared(runtime, handoff))).toMatchObject({ revision: 2, replay: true })
    expect(snapshot()).toEqual(after)
    expect(runtime.db.db.query<{ request_key: string; handoff_id: string }, [string]>(
      'SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = 2',
    ).get(task.id)).toEqual({ request_key: preparedKey(handoff.id), handoff_id: handoff.id })
    await runtime.reopen()
    expect(snapshot()).toEqual(after)
    expect((await read()).publication?.receipt).toEqual(receipt)
  } finally { await runtime.teardown() }
})
