// The pause service's targets and mail (revision-control 4.1, design D6),
// split from pauseService.test.ts: the targets derived from the held changes'
// live instruction states, the withdrawal of unclaimed instructions through
// reassignment's stop branch, and the one urgent direct system mail per
// holder — following forward chains to the successor, deferred for a spawning
// or unclaimed-successor target until its claim. Every mail write goes
// through the mailbox store inside the pause transaction, so
// `team_message_events` logs it. The cooling holder, refusals, replay, and
// the mail body stay in pauseService.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatHandoffPackage, TeamMessage } from '../../shared/team'
import type { AttemptManifest, FloorMap } from '../../shared/planExecution'
import type { PlanHold } from '../../shared/planRevisionControl'
import { outstandingOf, AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { initDatabase } from '../db'
import { PlanStore } from '../plans/planStore'
import { sessionRow, createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PauseService, PLAN_PAUSE_TAG, type PauseInput } from '../plans/revisionControl/pauseService'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { pauseTargetState, type PauseTargetFacts, type PauseTargetRecord } from '../plans/revisionControl/pauseState'

let world: PlanWorld
let bench: PlanBench
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const now = () => new Date(NOW)
const inDays = (days: number): string => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString()

let holds: HoldStore
let pauses: PauseStore
let executions: ExecutionStore
let service: PauseService
let teamId: string
let wakeCount = 0
let planCounter = 0
let dispatchCounter = 0

const wake = (): void => { wakeCount += 1 }

beforeAll(async () => {
  world = await createPlanWorld('kawai-pause-service-targets-')
  bench = createPlanBench(world)
  teamId = world.team.teamId
  bench.records.set('dev2', sessionRow('dev2', 'middle-devs', world.feature))
  bench.records.set('dev3', sessionRow('dev3', 'middle-devs', world.feature))
  const db = bench.db.db
  holds = new HoldStore(db, now)
  pauses = new PauseStore(db, now)
  executions = new ExecutionStore(db)
  service = new PauseService({
    pauses, holds, plans: bench.plans, planService: bench.service, executions,
    assignments: bench.assignmentStore, mailbox: bench.mail, sessionExists: id => bench.records.has(id), wake, now,
  })
})

afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

function expectOk<T>(outcome: { ok: boolean; message?: string; result?: T }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : outcome.message)
  return outcome.result
}

async function executionWith(changes: string[]): Promise<{ planId: string; executionId: string }> {
  // A change name is owned by one running execution per team (plan-execution D3);
  // every test builds its own plan, so earlier executions finish first.
  for (const row of executions.ownedChanges(teamId)) executions.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview()
  const approved = await bench.approve(draft.planId, draft.revision, `approve-pause-${++planCounter}`)
  if (!approved.ok) throw new Error(approved.message)
  const execution = executions.insertExecution({
    teamId, planId: draft.planId, revision: draft.revision, contentHash: 'hash-exec', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
    maxParallel: 3, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  })
  return { planId: draft.planId, executionId: execution.id }
}

const manifest = (): AttemptManifest => ({
  version: 1, plan: { id: 'p', revision: 1, contentHash: 'h' }, execution: 'e', task: { id: 't', revision: 1 },
  validation: { reportId: 'r', inputHash: 'i' }, baseline: 'b', startCommit: 's', artifacts: {}, roleProfiles: [],
})

/** A change with a task, an instruction mail, an assignment, an attempt, and `implementing` state. */
async function inFlight(executionId: string, change: string, holder = 'dev',
  claim: 'claim' | 'spawning' | 'queued' = 'claim'): Promise<{ taskId: string; mailId: string; assignmentId: string }> {
  const task = bench.tasks.create({ teamId, title: `${change} work`, direction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const message = bench.mail.enqueue({
    teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: world.repo, body: `Build ${change}.`, taskId: task.id, actor: 'human',
  })
  const inserted = bench.assignmentStore.insert({
    teamId, taskId: task.id, requestKey: `rk-${change}-${++dispatchCounter}`, targetKind: 'session', targetId: holder,
    role: null, instruction: `Build ${change}.`, creator: { kind: 'human', sessionId: null }, messageId: message.id,
  })
  if (claim === 'claim') bench.mail.claim(message.id, holder)
  else if (claim === 'spawning') bench.mail.reserveForSpawn(message.id)
  executions.insertAttempt({ executionId, change, kind: 'implement', assignmentId: inserted.assignment.id, manifest: manifest(), manifestHash: 'mh' })
  const row = executions.change(executionId, change)!
  const updated = executions.transition(executionId, change, row, { state: 'implementing', worktree: world.repo, branch: `${change}-branch`, taskId: task.id })
  if (!updated) throw new Error('the transition to implementing failed')
  return { taskId: task.id, mailId: message.id, assignmentId: inserted.assignment.id }
}

function forward(originalId: string, to: string): TeamMessage {
  const original = bench.mail.get(originalId)
  if (!original) throw new Error('the original message is gone')
  const handoff: ChatHandoffPackage = {
    fromSession: original.claimedBy ?? 'dev', fromProfile: 'default', claimCommit: null, lastError: null,
    progress: { toolCalls: 1, tools: ['Bash'], filesTouched: [] },
  }
  const successor = bench.mail.enqueue({
    teamId, toKind: 'session', toId: to, fromKind: 'agent', fromSession: original.claimedBy, fromGroup: 'middle-devs',
    originPath: world.repo, body: 'Handoff: finish this work.', taskId: original.taskId, actor: 'system',
    inReplyTo: original, handoff,
  })
  // A forward takes delivered (or parked) work, as the limit outcome does.
  bench.mail.markDelivered(original.id)
  bench.mail.markForwarded(original.id, `forwarded: ${successor.id}`)
  return successor
}

const placeHold = (planId: string, changes: string[], commandId: string): PlanHold =>
  holds.insert({ teamId, planId, scope: 'changes', rationale: 'rethink the direction', deadline: inDays(10), cites: null, commandId, changes })

const pause = (input: Partial<PauseInput> & { planId: string; holdId: string; commandId: string }) =>
  service.pause(bench.human, { deadline: inDays(2), ...input })

const pauseMails = (taskId: string): TeamMessage[] =>
  bench.mail.forTask(taskId).filter(message => message.tags.includes(PLAN_PAUSE_TAG))

const eventKinds = (messageId: string): string[] =>
  (bench.db.db.prepare('SELECT kind FROM team_message_events WHERE message_id = ? ORDER BY seq').all(messageId) as Array<{ kind: string }>).map(row => row.kind)

describe('targets and mail (D6)', () => {
  test('one urgent plan-pause mail per claimed holder, on the change task', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    const api = await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api', 'ui'], 'pa-h1')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-1' }))
    expect(wakeCount).toBe(1)
    const targets = pauses.targets(outcome.pause.id)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ change: 'api', stage: 'attempt', holderSession: 'dev', withdrawn: false })
    expect(targets[0].pausedAt).toBeNull()
    const mails = pauseMails(api.taskId)
    expect(mails).toHaveLength(1)
    expect(targets[0].messageId).toBe(mails[0].id)
    expect(mails[0]).toMatchObject({ toKind: 'session', toId: 'dev', fromKind: 'system', priority: 'urgent', state: 'queued', taskId: api.taskId })
    expect(mails[0].body).toContain('Stop at a safe point')
    expect(mails[0].body).toContain(`task_checkpoint(task_id: ${api.taskId}`)
    expect(mails[0].body).toContain('(api-branch)')
    expect(mails[0].body).toContain('Replies to this message are refused')
    expect(eventKinds(mails[0].id)).toContain('sent')
    // The waiting change is listed, not targeted.
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: ['ui'], landingInProgress: [] })
  })

  test('two developers are asked to pause: one pause, two targets, one mail on each change task (spec scenario)', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    const api = await inFlight(executionId, 'api')
    const ui = await inFlight(executionId, 'ui', 'dev2')
    // The second change moved on to its review handoff, claimed by dev2.
    const uiRow = executions.change(executionId, 'ui')!
    expect(executions.transition(executionId, 'ui', uiRow, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api', 'ui'], 'pa-hB1')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-b1' }))
    const targets = pauses.targets(outcome.pause.id)
    expect(targets).toHaveLength(2)
    expect(targets.map(target => [target.change, target.stage, target.holderSession, target.withdrawn])).toEqual([
      ['api', 'attempt', 'dev', false],
      ['ui', 'review', 'dev2', false],
    ])
    // One urgent plan-pause mail per developer, on its own change task.
    const apiMails = pauseMails(api.taskId)
    const uiMails = pauseMails(ui.taskId)
    expect(apiMails).toHaveLength(1)
    expect(uiMails).toHaveLength(1)
    expect(targets.find(target => target.change === 'api')!.messageId).toBe(apiMails[0]!.id)
    expect(targets.find(target => target.change === 'ui')!.messageId).toBe(uiMails[0]!.id)
    expect(apiMails[0]!.toId).toBe('dev')
    expect(uiMails[0]!.toId).toBe('dev2')
    expect(apiMails[0]!.body).toContain(`task_checkpoint(task_id: ${api.taskId}`)
    expect(uiMails[0]!.body).toContain('Submit nothing further for this review')
    expect(uiMails[0]!.body).not.toContain('task_checkpoint')
    expect(eventKinds(apiMails[0]!.id)).toContain('sent')
    expect(eventKinds(uiMails[0]!.id)).toContain('sent')
  })

  test('a change in review is targeted at its reviewer: stage review, asked only to stop', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev2')
    const row = executions.change(executionId, 'api')!
    expect(executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api'], 'pa-hB3')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-b3' }))
    const targets = pauses.targets(outcome.pause.id)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ change: 'api', stage: 'review', holderSession: 'dev2', withdrawn: false })
    const mails = pauseMails(api.taskId)
    expect(mails).toHaveLength(1)
    expect(targets[0].messageId).toBe(mails[0]!.id)
    expect(mails[0]!.toId).toBe('dev2')
    expect(mails[0]!.body).toContain('Submit nothing further for this review, and stop.')
    expect(mails[0]!.body).not.toContain('task_checkpoint')
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: [], landingInProgress: [] })
  })

  test('the holder follows one forward to the successor claimant', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    const successor = forward(api.mailId, 'dev2')
    bench.mail.claim(successor.id, 'dev2')
    const hold = placeHold(planId, ['api'], 'pa-h2')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-2' }))
    const target = pauses.targets(outcome.pause.id)[0]
    expect(target.holderSession).toBe('dev2')
    const mails = pauseMails(api.taskId)
    expect(mails).toHaveLength(1)
    expect(mails[0].toId).toBe('dev2')
    expect(bench.mail.get(api.mailId)!.state).toBe('forwarded')
  })

  test('a two-forward chain ends at the last claimant, mailed once', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev2')
    const first = forward(api.mailId, 'dev3')
    bench.mail.claim(first.id, 'dev3')
    const second = forward(first.id, 'stranger')
    bench.mail.claim(second.id, 'stranger')
    const hold = placeHold(planId, ['api'], 'pa-h3')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-3' }))
    expect(pauses.targets(outcome.pause.id)[0].holderSession).toBe('stranger')
    expect(pauseMails(api.taskId)).toHaveLength(1)
    expect(pauseMails(api.taskId)[0].toId).toBe('stranger')
  })

  test('an unclaimed forward successor defers the mail; deliverOwed mails it once the claim lands', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    const successor = forward(api.mailId, 'dev2')
    const hold = placeHold(planId, ['api'], 'pa-h4')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-4' }))
    const target = pauses.targets(outcome.pause.id)[0]
    expect(target).toMatchObject({ holderSession: null, messageId: null, withdrawn: false })
    expect(pauseMails(api.taskId)).toHaveLength(0)
    bench.mail.claim(successor.id, 'dev2')
    expect(service.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual(['api'])
    const after = pauses.targets(outcome.pause.id)[0]
    expect(after.holderSession).toBe('dev2')
    expect(pauseMails(api.taskId)).toHaveLength(1)
    // The once-marker is message_id: a second pass sends nothing.
    expect(service.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual([])
    expect(pauseMails(api.taskId)).toHaveLength(1)
  })

  test('a spawning instruction waits for its claim, then one mail (the claim is the once-marker)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'spawning')
    const hold = placeHold(planId, ['api'], 'pa-h5')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-5' }))
    const target = pauses.targets(outcome.pause.id)[0]
    expect(target).toMatchObject({ holderSession: null, messageId: null, withdrawn: false })
    expect(pauseMails(api.taskId)).toHaveLength(0)
    expect(bench.mail.claimSpawned(api.mailId, 'dev')).toBe(true)
    expect(service.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual(['api'])
    expect(pauseMails(api.taskId)).toHaveLength(1)
    expect(service.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual([])
    expect(pauseMails(api.taskId)).toHaveLength(1)
  })

  test('after a restart the owed mail is still sent exactly once: the marker is the stored row', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'spawning')
    const hold = placeHold(planId, ['api'], 'pa-hB5')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-b5' }))
    expect(bench.mail.claimSpawned(api.mailId, 'dev')).toBe(true)
    expect(service.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual(['api'])
    expect(pauseMails(api.taskId)).toHaveLength(1)
    const mailed = pauseMails(api.taskId)[0]!
    // Reopen the same database through a second connection and rebuild the
    // service over it — the tick after a restart (condition e).
    const reopened = initDatabase({ path: bench.db.db.filename })
    try {
      const mail = new MailboxStore(reopened.db)
      const rebuilt = new PauseService({
        pauses: new PauseStore(reopened.db, now),
        holds: new HoldStore(reopened.db, now),
        plans: new PlanStore(reopened.db),
        // deliverOwed never reaches the plan service; the rebuilt stores carry the reads it does.
        planService: bench.service,
        executions: new ExecutionStore(reopened.db),
        assignments: new AssignmentStore(reopened.db, mail),
        mailbox: mail,
        sessionExists: id => bench.records.has(id),
        now,
      })
      expect(rebuilt.deliverOwed(teamId, world.repo, outcome.pause.id)).toEqual([])
    } finally {
      reopened.close()
    }
    expect(pauseMails(api.taskId)).toHaveLength(1)
    expect(eventKinds(mailed.id).filter(kind => kind === 'sent')).toHaveLength(1)
  })

  test('an instruction held for a request is withdrawn like a queued one: cancelled mail, superseded assignment, Paused', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'queued')
    expect(bench.mail.holdForRequest(api.mailId)).toBe(true)
    expect(bench.mail.get(api.mailId)!.state).toBe('awaiting-request')
    const hold = placeHold(planId, ['api'], 'pa-hB2')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-b2' }))
    const target = pauses.targets(outcome.pause.id)[0]
    expect(target.withdrawn).toBe(true)
    expect(target.holderSession).toBeNull()
    expect(target.pausedAt).not.toBeNull()
    expect(bench.mail.get(api.mailId)!.state).toBe('cancelled')
    expect(eventKinds(api.mailId)).toEqual(expect.arrayContaining(['held-for-request', 'cancelled']))
    const [assignment] = bench.assignmentStore.listByTask(api.taskId)
    expect(assignment.supersededBy).toBe(outcome.pause.id)
    expect(assignment.state).toBe('superseded')
    expect(outstandingOf(bench.assignmentStore.listByTask(api.taskId))).toBeNull()
    expect(pauseMails(api.taskId)).toHaveLength(0)
    // The recorded Paused fact reads as the derived state Paused (D8).
    const facts: PauseTargetFacts = {
      executionFinished: false, messageDelivered: false, spawnUnclaimed: false, pendingRequest: false, busy: false,
      providerLimit: null, holder: 'live', readiness: { ready: true, reasons: [] }, deadlinePassed: false,
    }
    const record: PauseTargetRecord = {
      stage: 'attempt', holderSession: null, withdrawn: target.withdrawn, pausedAt: target.pausedAt,
      decision: target.decision, checkpointKind: null, pushEffectState: null,
    }
    expect(pauseTargetState(record, facts).state).toBe('paused')
  })

  test('a queued instruction is withdrawn through the stop branch: cancelled mail, superseded assignment, Paused at once', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'queued')
    const hold = placeHold(planId, ['api'], 'pa-h6')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-6' }))
    const target = pauses.targets(outcome.pause.id)[0]
    expect(target.withdrawn).toBe(true)
    expect(target.holderSession).toBeNull()
    expect(target.pausedAt).not.toBeNull()
    expect(bench.mail.get(api.mailId)!.state).toBe('cancelled')
    expect(eventKinds(api.mailId)).toContain('cancelled')
    const [assignment] = bench.assignmentStore.listByTask(api.taskId)
    expect(assignment.supersededBy).toBe(outcome.pause.id)
    expect(assignment.state).toBe('superseded')
    expect(outstandingOf(bench.assignmentStore.listByTask(api.taskId))).toBeNull()
    expect(pauseMails(api.taskId)).toHaveLength(0)
  })

  test('Kawai-held steps and a task-less change are listed as having no active work, not targeted', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui', 'ops', 'docs'])
    await inFlight(executionId, 'api')
    // ui stays waiting; ops sits in a Kawai-held CI step; docs is implementing without a task yet.
    const opsRow = executions.change(executionId, 'ops')!
    expect(executions.transition(executionId, 'ops', opsRow, { state: 'gating', step: 'awaiting-ci' })).not.toBeNull()
    const docsRow = executions.change(executionId, 'docs')!
    expect(executions.transition(executionId, 'docs', docsRow, { state: 'implementing', worktree: world.repo, branch: 'docs-branch' })).not.toBeNull()
    const hold = placeHold(planId, ['api', 'ui', 'ops', 'docs'], 'pa-h7')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-7' }))
    expect(pauses.targets(outcome.pause.id).map(target => target.change)).toEqual(['api'])
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: ['ui', 'ops', 'docs'], landingInProgress: [] })
  })

  test('an owed fix attempt names no holder: the previous stage claimant is never the attempt holder (H7)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    // A review handoff was claimed and its verdict failed the round; the fix
    // attempt was minted but its dispatch never went out (a hold withheld
    // it). The outstanding assignment is still the reviewer's, so the owed
    // attempt has no holder to pause — the change has no active work.
    const reviewMail = bench.mail.enqueue({
      teamId, toKind: 'session', toId: 'dev2', fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'Review api.', taskId: api.taskId, actor: 'system',
    })
    bench.mail.claim(reviewMail.id, 'dev2')
    bench.assignmentStore.insert({
      teamId, taskId: api.taskId, requestKey: `rk-review-${++dispatchCounter}`, targetKind: 'session', targetId: 'dev2',
      role: null, instruction: 'Review api.', creator: { kind: 'human', sessionId: null }, messageId: reviewMail.id,
    })
    executions.insertAttempt({
      executionId, change: 'api', kind: 'fix', assignmentId: null,
      manifest: { ...manifest(), answers: { resultId: 'res-1', roundId: 'round-1', failingChecks: [], findingsIds: [] } },
      manifestHash: 'mh-fix',
    })
    const hold = placeHold(planId, ['api'], 'pa-h9')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-9' }))
    expect(pauses.targets(outcome.pause.id)).toEqual([])
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: ['api'], landingInProgress: [] })
    expect(pauseMails(api.taskId)).toEqual([])
  })

  test('a linked fix attempt keeps its holder: the pause targets its claimant (H7 bounds)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    // The fix attempt dispatched: its assignment carries the attempt's key
    // and dev3 claimed it, so the newest row is out, not owed — the change
    // has live work and its claimant gets the pause mail.
    const fixMail = bench.mail.enqueue({
      teamId, toKind: 'session', toId: 'dev3', fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'Fix api.', taskId: api.taskId, actor: 'system',
    })
    bench.mail.claim(fixMail.id, 'dev3')
    const fixAssignment = bench.assignmentStore.insert({
      teamId, taskId: api.taskId, requestKey: `exec:${executionId}:api:attempt:2:0`, targetKind: 'session', targetId: 'dev3',
      role: null, instruction: 'Fix api.', creator: { kind: 'human', sessionId: null }, messageId: fixMail.id,
    })
    executions.insertAttempt({
      executionId, change: 'api', kind: 'fix', assignmentId: fixAssignment.assignment.id,
      manifest: { ...manifest(), answers: { resultId: 'res-1', roundId: 'round-1', failingChecks: [], findingsIds: [] } },
      manifestHash: 'mh-fix',
    })
    const hold = placeHold(planId, ['api'], 'pa-h10')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-10' }))
    expect(pauses.targets(outcome.pause.id)).toEqual([expect.objectContaining({ change: 'api', stage: 'attempt', holderSession: 'dev3' })])
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: [], landingInProgress: [] })
    expect(pauseMails(api.taskId)).toEqual([expect.objectContaining({ toId: 'dev3', priority: 'urgent' })])
  })

  test('a started update or merge lists as landing in progress and is left alone', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    await inFlight(executionId, 'api')
    const uiRow = executions.change(executionId, 'ui')!
    expect(executions.transition(executionId, 'ui', uiRow, { state: 'landing', step: 'merging' })).not.toBeNull()
    const hold = placeHold(planId, ['api', 'ui'], 'pa-h8')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-8' }))
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: [], landingInProgress: ['ui'] })
    expect(pauses.targets(outcome.pause.id).map(target => target.change)).toEqual(['api'])
  })

  test('a started update (the updating step) lists as landing in progress and writes nothing for the change', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    const api = await inFlight(executionId, 'api')
    const uiRow = executions.change(executionId, 'ui')!
    expect(executions.transition(executionId, 'ui', uiRow, { state: 'landing', step: 'updating' })).not.toBeNull()
    const hold = placeHold(planId, ['api', 'ui'], 'pa-hB4')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-b4' }))
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: [], landingInProgress: ['ui'] })
    expect(pauses.targets(outcome.pause.id).map(target => target.change)).toEqual(['api'])
    // The updating change is left alone; the attempt beside it is targeted and mailed.
    expect(pauseMails(api.taskId)).toHaveLength(1)
  })

  test('a plan-scoped hold covers every in-flight change, not just listed ones', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    const api = await inFlight(executionId, 'api')
    const ui = await inFlight(executionId, 'ui', 'dev2')
    const hold = holds.insert({
      teamId, planId, scope: 'plan', rationale: 'rethink the direction', deadline: inDays(10), cites: null,
      commandId: 'pa-hN2', changes: [],
    })
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-n2' }))
    expect(pauses.targets(outcome.pause.id).map(target => [target.change, target.holderSession, target.stage])).toEqual([
      ['api', 'dev', 'attempt'],
      ['ui', 'dev2', 'attempt'],
    ])
    expect(pauseMails(api.taskId)).toHaveLength(1)
    expect(pauseMails(ui.taskId)).toHaveLength(1)
    expect(service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: [], landingInProgress: [] })
  })
})
