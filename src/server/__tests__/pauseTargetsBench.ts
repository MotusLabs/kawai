// The shared bench behind the pause-targets suites (revision-control 4.1,
// design D6): one plan world, the hold/pause/execution stores, and the
// PauseService over them, with the helpers both suites share. Split from
// pauseServiceTargets.test.ts (CP2a B4) so each suite stays under 500 lines;
// the cooling holder, refusals, replay, and the mail body stay in
// pauseService.test.ts.
import fs from 'node:fs'
import type { ChatHandoffPackage, TeamMessage } from '../../shared/team'
import type { AttemptManifest, FloorMap } from '../../shared/planExecution'
import type { PlanHold } from '../../shared/planRevisionControl'
import { sessionRow, createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PauseService, PLAN_PAUSE_TAG, type PauseInput, type PauseOutcome } from '../plans/revisionControl/pauseService'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { TaskService } from '../team/TaskService'
import { AssignmentService } from '../team/AssignmentService'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)

let planCounter = 0
let dispatchCounter = 0

/** One suite's wired bench: the stores, the service, and the shared helpers. */
export interface PauseTargetsBench {
  world: PlanWorld
  bench: PlanBench
  teamId: string
  holds: HoldStore
  pauses: PauseStore
  executions: ExecutionStore
  /** The task service and the checkpoint store, wired as the production composition does (the resolve reads both). */
  tasks: TaskService
  checkpoints: CheckpointStore
  service: PauseService
  now: () => Date
  inDays: (days: number) => string
  /** The wake calls the service made (the executor's pause wake). */
  wakes: () => number
  expectOk: <T>(outcome: { ok: boolean; message?: string; result?: T }) => T
  executionWith: (changes: string[]) => Promise<{ planId: string; executionId: string }>
  manifest: () => AttemptManifest
  inFlight: (executionId: string, change: string, holder?: string, claim?: 'claim' | 'spawning' | 'queued', mintAttempt?: boolean) => Promise<{ taskId: string; mailId: string; assignmentId: string }>
  forward: (originalId: string, to: string) => TeamMessage
  placeHold: (planId: string, changes: string[], commandId: string) => PlanHold
  pause: (input: Partial<PauseInput> & { planId: string; holdId: string; commandId: string }) => PauseOutcome
  pauseMails: (taskId: string) => TeamMessage[]
  eventKinds: (messageId: string) => string[]
  close: () => void
}

export async function pauseTargetsBench(prefix: string): Promise<PauseTargetsBench> {
  const world = await createPlanWorld(prefix)
  const bench = createPlanBench(world)
  const teamId = world.team.teamId
  const now = (): Date => new Date(NOW)
  const inDays = (days: number): string => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString()
  bench.records.set('dev2', sessionRow('dev2', 'middle-devs', world.feature))
  bench.records.set('dev3', sessionRow('dev3', 'middle-devs', world.feature))
  let wakeCount = 0
  const wake = (): void => { wakeCount += 1 }
  const holds = new HoldStore(bench.db.db, now)
  const pauses = new PauseStore(bench.db.db, now)
  const executions = new ExecutionStore(bench.db.db)
  const checkpoints = new CheckpointStore(bench.db.db, now)
  const tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id) ?? null })
  // The resolve's inline fix dispatch (revision-control 4.4, A2r) goes
  // through the real AssignmentService — the same request-key grammar, mail,
  // and journal a production dispatch writes.
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, bench.mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignmentService = new AssignmentService(bench.db.db, bench.assignmentStore, bench.tasks, bench.mail, {
    getSession: id => bench.records.get(id) ?? null, records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans,
  })
  const service = new PauseService({
    pauses, holds, plans: bench.plans, planService: bench.service, executions,
    assignments: bench.assignmentStore, mailbox: bench.mail, sessionExists: id => bench.records.has(id), wake, now,
    tasks, checkpoints, assignmentService,
    // Adapt's pre-transaction git facts (rev4 §2): a distinguishable head
    // the manifest must record verbatim.
    adaptHead: () => ({ startCommit: 'adapt-head-sha', artifacts: {} }),
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

  /** A change with a task, an instruction mail, an assignment, an attempt (unless `mintAttempt` is false — C2's `—` axis), and `implementing` state. */
  async function inFlight(executionId: string, change: string, holder = 'dev',
    claim: 'claim' | 'spawning' | 'queued' = 'claim', mintAttempt = true): Promise<{ taskId: string; mailId: string; assignmentId: string }> {
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
    if (mintAttempt) executions.insertAttempt({ executionId, change, kind: 'implement', assignmentId: inserted.assignment.id, manifest: manifest(), manifestHash: 'mh' })
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

  const pauseMails = (taskId: string): TeamMessage[] =>
    bench.mail.forTask(taskId).filter(message => message.tags.includes(PLAN_PAUSE_TAG))

  const eventKinds = (messageId: string): string[] =>
    (bench.db.db.prepare('SELECT kind FROM team_message_events WHERE message_id = ? ORDER BY seq').all(messageId) as Array<{ kind: string }>).map(row => row.kind)

  return {
    world, bench, teamId, holds, pauses, executions, tasks, checkpoints, service, now, inDays,
    wakes: () => wakeCount,
    expectOk,
    executionWith,
    manifest,
    inFlight,
    forward,
    placeHold,
    pause: input => service.pause(bench.human, { deadline: inDays(2), ...input }),
    pauseMails,
    eventKinds,
    close: () => {
      bench.db.close()
      fs.rmSync(world.root, { recursive: true, force: true })
    },
  }
}
