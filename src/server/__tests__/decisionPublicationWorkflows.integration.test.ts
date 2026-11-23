import { expect, test } from 'bun:test'
import type { PlanDecisionCardView } from '../../shared/planDecisions'
import type { TeamMessage } from '../../shared/team'
import { PREPARED } from './helpers/decisionPublicationBench'
import { bind, prepare, type PublicationRuntime } from './helpers/decisionPublicationCommands'
import { publicationRuntime, waitFor } from './helpers/decisionPublicationRuntime'

async function successor(runtime: PublicationRuntime) {
  const created = await runtime.manager.createAvailableSession({ projectPath: runtime.feature, groupId: 'middle-devs' })
  if (!created.ok) throw new Error(created.error)
  return created.session.id
}

function pinResult(runtime: PublicationRuntime) {
  const { task, manager, holder, feature } = runtime
  return manager.tasks.store.results.insert({
    teamId: task.teamId, taskId: task.id, taskRevision: 1, summary: 'Original holder output', worktree: feature,
    commit: null, diff: 'Pinned base result', tests: [], limitations: null, submittedBy: { kind: 'agent', sessionId: holder },
  })
}

function notices(runtime: PublicationRuntime, taskId = runtime.task.id) {
  return runtime.manager.mailbox.store.forTask(taskId).filter(message => message.tags.includes('task-revision'))
}

// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Publication reaches the current holder and requester
// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Delivery and acknowledgement remain distinct
// @covers: plan-decisions › One approval intent has one durable receipt › Later decisions preserve the original receipt
test('W05 commit-time forward successor gets the original notice while reassignment and ACK leave old pins and receipt intact', async () => {
  const runtime = await publicationRuntime()
  try {
    const { manager, holder, task, initialMessageId, teamPath, routed, holderTool } = runtime
    const { approve, read } = await bind(runtime, await prepare(runtime))
    const result = pinResult(runtime)
    await holderTool('task_acknowledge', { task_id: task.id, revision: 1 })
    const next = await successor(runtime)
    const mail = manager.mailbox.store
    const original = mail.get(initialMessageId)!
    const instruction = mail.enqueue({
      teamId: task.teamId, toKind: 'session', toId: next, fromKind: 'agent', fromSession: holder, fromGroup: 'middle-devs',
      originPath: runtime.feature, body: 'Continue the original work', taskId: task.id, inReplyTo: original,
      attachThread: true, handoff: { fromSession: holder, fromProfile: 'sonnet', claimCommit: original.claimCommit,
        lastError: 'capacity', progress: { toolCalls: 0, tools: [], filesTouched: [] } },
    })
    expect(mail.markForwarded(initialMessageId, instruction.id)).toBe(true)
    await waitFor(() => mail.get(instruction.id)?.state === 'delivered', 'the actual forwarded assignment')
    expect(mail.get(instruction.id)).toMatchObject({ claimedBy: next, taskRevision: 1 })
    const approved = await routed('team-plan-result', approve)
    expect(approved.error).toBeUndefined()
    const receipt = approved.publication!
    const [noticeId] = receipt.noticeMessageIds
    expect(receipt.noticeMessageIds).toHaveLength(1)
    await waitFor(() => mail.get(noticeId!)?.state === 'delivered', 'the forwarded holder notice')
    expect(notices(runtime)).toMatchObject([{ id: noticeId, toId: next, taskRevision: 2, claimedBy: next,
      revisionNotice: { revision: 2, previousRevision: 1, rationale: PREPARED.rationale } }])
    expect(mail.get(noticeId!)?.body).toContain(PREPARED.rationale)
    expect(mail.get(receipt.wakeupMessageId!)).toMatchObject({ toId: runtime.lead, taskId: null })
    const acks = manager.tasks.store.acknowledgements
    expect(acks.highest(task.id, holder)).toBe(1)
    expect(acks.highest(task.id, next)).toBeNull()
    await holderTool('task_acknowledge', { task_id: task.id, revision: 2 })
    expect(acks.highest(task.id, next)).toBe(2)

    const laterHolder = await successor(runtime)
    const refused = await routed('team-task-result', { type: 'team-task-assign', teamPath, taskId: task.id, requestId: 'reassign',
      target: { kind: 'session', id: laterHolder }, instruction: 'Take over at the current published version', requestKey: 'later-holder' })
    expect(refused.error).toContain('owned by a running execution')
    const reassigned = await manager.assignments.dispatch({ kind: 'system', team: runtime.team,
      origin: { kind: 'execution', executionId: runtime.execution.id } }, {
      taskId: task.id, target: { kind: 'session', id: laterHolder }, instruction: 'Take over at the current published version',
      requestKey: 'execution-later-holder', handling: 'notify',
    })
    const message = reassigned.assignment.messageId!
    await waitFor(() => mail.get(message)?.state === 'delivered', 'the reassigned instruction')
    expect(mail.get(message)).toMatchObject({ claimedBy: laterHolder, taskRevision: 2 })
    expect(acks.highest(task.id, laterHolder)).toBeNull()
    expect(mail.get(initialMessageId)?.taskRevision).toBe(1)
    expect(mail.get(instruction.id)?.taskRevision).toBe(1)
    expect(manager.tasks.store.results.get(result.id)?.taskRevision).toBe(1)
    expect((await read()).publication?.receipt).toEqual(receipt)
    await runtime.settleDelivery()
    const before = runtime.snapshot()
    expect(await routed('team-plan-result', { ...approve, requestId: 'after-reassignment' })).toMatchObject({ publication: receipt, replayed: true })
    expect(runtime.snapshot()).toEqual(before)
  } finally { await runtime.teardown() }
})

// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › An unclaimed assignment needs no notice
test('W05 an unclaimed assignment gets no notice and later instruction delivery carries the new revision without ACK', async () => {
  const runtime = await publicationRuntime()
  try {
    const { manager, task, initialMessageId, routed, db } = runtime
    const handoff = await prepare(runtime)
    const { approve } = await bind(runtime, handoff)
    const mail = manager.mailbox.store
    expect(mail.release(initialMessageId, 'middle-devs', new Date(Date.now() + 60_000).toISOString())).toBe(true)
    const response = await routed('team-plan-result', approve)
    expect(response).toMatchObject({ publication: { taskId: task.id, noticeMessageIds: [], publishedRevision: 2 } })
    expect(notices(runtime)).toEqual([])
    expect(mail.get(initialMessageId)).toMatchObject({ state: 'queued', claimedBy: null })
    db.db.prepare('UPDATE team_messages SET deliver_at = NULL WHERE id = ?').run(initialMessageId)
    manager['dispatcher'].notify()
    await waitFor(() => mail.get(initialMessageId)?.state === 'delivered', 'the originally unclaimed instruction')
    const instruction = mail.get(initialMessageId)!
    expect(instruction.taskRevision).toBe(2)
    expect(manager.tasks.store.acknowledgements.highest(task.id, instruction.claimedBy!)).toBeNull()
  } finally { await runtime.teardown() }
})

test.each(['archived', 'killed'] as const)('W05 %s claimant retains the committed notice identity and normal delivery behavior', async (variant) => {
  const runtime = await publicationRuntime()
  try {
    const { manager, holder, routed, task } = runtime
    const { approve, read } = await bind(runtime, await prepare(runtime))
    if (variant === 'archived') expect(manager.archive(holder).ok).toBe(true)
    else expect(manager.kill(holder)).toBe(true)
    const approved = await routed('team-plan-result', approve)
    expect(approved.error).toBeUndefined()
    const receipt = approved.publication!
    expect(receipt.noticeMessageIds).toHaveLength(1)
    const [id] = receipt.noticeMessageIds
    const state = variant === 'archived' ? 'delivered' : 'dead'
    await waitFor(() => manager.mailbox.store.get(id!)?.state === state, `the notice to the ${variant} holder`)
    expect(notices(runtime)).toMatchObject([{ id, toId: holder, state, taskId: task.id }])
    expect(manager.tasks.store.acknowledgements.highest(task.id, holder)).toBeNull()
    expect((await read()).publication?.receipt).toEqual(receipt)
  } finally { await runtime.teardown() }
})

// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Delivery and acknowledgement remain distinct
test.each(['delivered', 'dead', 'uncertain'] as const)('W06 %s notice and owner Notify or Retry retain the original publication and receipt', async (state) => {
  const runtime = await publicationRuntime()
  try {
    const { manager, holder, task, teamPath, routed, route, db } = runtime
    const { approve, read } = await bind(runtime, await prepare(runtime))
    if (state !== 'delivered') await runtime.pauseDelivery()
    const receipt = (await routed('team-plan-result', approve)).publication!
    expect(receipt.noticeMessageIds).toHaveLength(1)
    const [noticeId] = receipt.noticeMessageIds
    const mail = manager.mailbox.store
    if (state === 'dead') expect(mail.deadLetter(noticeId!, 'recorded failure')).toBe(true)
    if (state === 'uncertain') {
      expect(mail.claim(noticeId!, holder)).toBe(true)
      expect(mail.markPushed(noticeId!, undefined, 2)).toBe(true)
      expect(mail.holdUncertain(noticeId!, 'transcript-unreadable')).toBe(true)
    }
    await waitFor(() => mail.get(noticeId!)?.state === state, 'the intended initial notice disposition')
    const before = manager.tasks.store.revisions(task.id)
    const notify = { type: 'team-task-notify' as const, teamPath, taskId: task.id, revision: 2, requestId: 'notify', requestKey: 'retry-notice' }
    expect((await routed('team-task-result', notify)).error).toBeUndefined()
    expect(notices(runtime)).toHaveLength(state === 'dead' ? 2 : 1)
    if (state === 'dead') {
      expect(await routed('team-task-result', { ...notify, requestId: 'same-notify' })).toMatchObject({ replay: true })
      expect(notices(runtime)).toHaveLength(2)
    }
    if (state === 'uncertain') {
      route({ type: 'team-mailbox-retry', teamPath, messageId: noticeId! })
      await waitFor(() => mail.get(noticeId!)?.state === 'queued', 'the original uncertain mail retried')
      expect(notices(runtime)).toHaveLength(1)
    }
    expect(manager.tasks.store.revisions(task.id)).toEqual(before)
    expect(db.db.prepare('SELECT id FROM plan_decisions WHERE card_id = ?').all(approve.cardId)).toEqual([{ id: receipt.decisionId }])
    expect((await read()).publication?.receipt).toEqual(receipt)
    expect(manager.tasks.store.acknowledgements.highest(task.id, holder)).toBeNull()
  } finally { await runtime.teardown() }
})

// @covers: plan-decisions › Questions go to the Lead role, else to the owner › A dev's question reaches the Lead
// @covers: plan-decisions › Questions go to the Lead role, else to the owner › The Lead's question reaches the owner
// @covers: plan-decisions › The owner answers open cards › The owner answers before the Lead
// @covers: plan-decisions › The owner answers open cards › Answer replayed
// @covers: plan-decisions › The owner answers open cards › Answering a bound card publishes nothing
test('W09 ordinary owner answers keep routed mail while approval-like bound answers leave focus and publication untouched', async () => {
  const runtime = await publicationRuntime()
  try {
    const { manager, lead, task, plan, teamPath, holderTool, leadTool, routed, db } = runtime
    const { other } = await runtime.sendFocus('unlinked')
    const { answer, approve, read } = await bind(runtime, await prepare(runtime))
    await runtime.pauseDelivery()
    const ordinary = await holderTool<{ card_id: string; addressed_to: string }>('decision_ask', { question: 'An ordinary Lead question?' })
    expect(ordinary.addressed_to).toBe('lead')
    const mail = manager.mailbox.store
    const questionId = manager.decisions!.deps.decisions.card(task.teamId, ordinary.card_id)!.messageId!
    expect(mail.get(questionId)).toMatchObject({ state: 'queued', toId: 'leads' })
    const first = { ...answer, cardId: ordinary.card_id, requestId: 'ordinary-answer', commandId: 'answer-ordinary' }
    const answered = await routed('team-plan-result', first)
    expect(answered.error).toBeUndefined()
    expect(mail.get(questionId)?.state).toBe('cancelled')
    expect(mail.get(answered.decision!.decision.replyMessageId!)).toMatchObject({ taskId: task.id, toId: runtime.holder })
    const beforeReplay = runtime.snapshot()
    expect(await routed('team-plan-result', { ...first, requestId: 'ordinary-replay' })).toMatchObject({ decision: answered.decision, replayed: true })
    expect(runtime.snapshot()).toEqual(beforeReplay)
    const own = await leadTool<{ card_id: string; addressed_to: string }>('decision_ask', {
      plan_id: plan.planId, question: 'An ordinary owner question?',
    })
    expect(own.addressed_to).toBe('owner')
    expect((await leadTool<{ decisions: PlanDecisionCardView[] }>('plan_get', { plan_id: plan.planId }))
      .decisions.find(card => card.card.id === own.card_id)?.publication).toBeUndefined()
    const boundAnswer = await routed('team-plan-result', answer)
    const reply = mail.get(boundAnswer.decision!.decision.replyMessageId!) as TeamMessage
    expect(reply).toMatchObject({ toId: lead, taskId: null, tags: ['decision-answer'], body: expect.stringContaining(approve.cardId) })
    expect(db.getChatSession(lead)?.taskId).toBe(other.id)
    expect((await read()).publication?.receipt).toBeNull()
    expect(manager.tasks.store.revisions(task.id)).toHaveLength(1)
    expect((await routed('team-plan-result', approve)).reason).toBe('state')
  } finally { await runtime.teardown() }
})

// @covers: plan-decisions › One approval intent has one durable receipt › Later decisions preserve the original receipt
test('W09 owner override after publication creates its normal fix and retains the historical receipt', async () => {
  const runtime = await publicationRuntime()
  try {
    const { routed, manager, task } = runtime
    const { approve, read } = await bind(runtime, await prepare(runtime))
    const first = await routed('team-plan-result', approve)
    const receipt = first.publication!
    const revision = manager.tasks.store.revisions(task.id).at(-1)
    const override = await routed('team-plan-result', {
      type: 'team-plan-override', teamPath: approve.teamPath, planId: approve.planId, cardId: approve.cardId, requestId: 'override',
      commandId: 'override-publication-answer', expectedDecisionId: receipt.decisionId, choice: 'Build a forward fix', rationale: 'The export needs one more field',
    })
    expect(override.error).toBeUndefined()
    expect(override.decision?.decision).toMatchObject({ kind: 'override', seq: 2 })
    const view = await read()
    expect(view.fixes).toHaveLength(1)
    expect(view.publication?.receipt).toEqual(receipt)
    expect(manager.tasks.store.revisions(task.id).at(-1)).toEqual(revision)
    expect(await routed('team-plan-result', { ...approve, requestId: 'after-override' })).toMatchObject({ decision: first.decision, publication: receipt, replayed: true })
  } finally { await runtime.teardown() }
})
