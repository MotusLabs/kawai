import fs from 'node:fs'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerWebSocket } from 'bun'
import { CI_FLOOR_CHECKS, FLOOR_VERSION, type AttemptManifest, type FloorMap } from '../../../shared/planExecution'
import { normalizePlanContent } from '../../../shared/plans'
import { parseContract } from '../../../shared/implementationContract'
import { SYSTEM_ACTOR } from '../../../shared/team'
import { planInput } from '../../../shared/__tests__/planFixtures'
import type { ClientMessage, ServerMessage } from '../../../shared/types'
import { SessionRegistry } from '../../SessionRegistry'
import { initDatabase, type SessionDatabase } from '../../db'
import { ChatConnections } from '../../chat/ChatConnections'
import { ChatSessionManager } from '../../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../../chat/developmentFixture'
import { hashManifest } from '../../plans/execution/manifestHash'
import { ExecutionStore } from '../../plans/execution/executionStore'
import { ExecutionRevisionStore } from '../../plans/revisionControl/executionRevisionStore'
import { hashPlanRevision } from '../../plans/planHash'
import { handleMessage, type MessageRouterContext } from '../../ws/messageRouter'
import { LEAD_ROLES } from '../decisionHarness'
import { createPlanWorld, git, writeGroup } from '../planHarness'
import { freshTestDatabase } from './testDatabase'
import { decisionWriteSnapshot, HUMAN } from './decisionPublicationBench'

type Registered = Record<string, { handler: (input: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>
type WireType = 'team-plan-result' | 'team-task-result'
export type Focus = 'unlinked' | 'sibling' | 'other-plan'
const CONTRACT = parseContract(`## Implementation contract
### Acceptance
- A1: Export has headers
### Invariants
### Scope
- src/**
### Verification
- V1: Inspect the CSV
### Excluded`).contract!

export async function waitFor(test: () => boolean, label: string) {
  const end = Date.now() + 7_000
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function publicationRuntime() {
  const world = await createPlanWorld('kawai-decision-runtime-')
  const { root, repo, feature, team } = world
  const teamPath = repo
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead work.')
  writeGroup(world, 'middle-devs', '---\nprofiles: [sonnet]\nmax: 3\n---\nBuild features.')
  const pinnedCommit = git(['rev-parse', 'HEAD'], feature).trim()
  const origin = path.join(root, 'origin.git')
  git(['clone', '-q', '--bare', repo, origin], repo)
  git(['remote', 'add', 'origin', origin], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  const transcriptDir = path.join(root, 'claude', 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  const filename = path.join(root, 'state.db')
  let db = freshTestDatabase(filename)
  const servers = new Map<string, Options['mcpServers']>()
  const filesByWorktree = new Map<string, Set<string>>()
  let connections: ChatConnections | null = null
  const boot = (db: SessionDatabase) => new ChatSessionManager({
    onMailboxChange: (teamId, message) => connections?.publishMailbox(teamId, message),
    onWaitingReasonsChange: teamId => connections?.publishMailbox(teamId),
    onTaskChange: teamId => connections?.publishTasks(teamId),
    onPlanChange: (teamId, planId) => connections?.publishPlans(teamId, planId),
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls in the fixture') }) as unknown as typeof fetch,
    queryFactory: params => {
      const cwd = params.options.cwd ?? ''
      servers.set(cwd, params.options.mcpServers)
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      const files = filesByWorktree.get(cwd) ?? new Set<string>()
      files.add(file)
      filesByWorktree.set(cwd, files)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      const prompt = (async function* () {
        for await (const message of params.prompt) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
        for await (const message of fixture) {
          if (message.type !== 'system' || message.subtype !== 'init') yield message
        }
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  const frames: ServerMessage[] = []
  const lostReplies = new Set<string>()
  const connection = { send: (frame: ServerMessage) => {
    if ('requestId' in frame && frame.requestId && lostReplies.delete(frame.requestId)) return
    frames.push(frame)
  } }
  let manager = boot(db)
  connections = new ChatConnections(manager)
  const route = (message: ClientMessage) => {
    const router = { hub: { send: () => {} }, chatConnections: connections, chatPeer: () => connection } as unknown as MessageRouterContext
    handleMessage(router, {} as ServerWebSocket<never>, JSON.stringify(message))
  }
  const routed = async <T extends WireType>(type: T, message: Extract<ClientMessage, { requestId: string }>) => {
    const start = frames.length
    route(message)
    const answer = () => frames.slice(start).find((frame): frame is Extract<ServerMessage, { type: T }> =>
      frame.type === type && 'requestId' in frame && frame.requestId === message.requestId)
    await waitFor(() => !!answer(), `the routed ${message.type} result`)
    return answer()!
  }
  const registry = (cwd: string): Registered =>
    ((servers.get(cwd)!['kawai-team'] as { instance: unknown }).instance as { _registeredTools: Registered })._registeredTools
  const tool = async <T>(cwd: string, name: string, input: unknown): Promise<T> => {
    const handler = registry(cwd)[name]
    if (!handler) throw new Error(`Missing registered ${name}`)
    const reply = await handler.handler(input, {})
    const result = reply.content[0]!.text
    if (reply.isError) throw new Error(`${name}: ${result}`)
    return JSON.parse(result) as T
  }
  const transcript = (sessionId: string) => {
    const cwd = db.getChatSession(sessionId)?.projectPath
    return [...(filesByWorktree.get(cwd ?? '') ?? [])].map(file => fs.readFileSync(file, 'utf8')).join('\n')
  }
  const stop = async () => {
    manager.shutdown()
    await manager['executionRuntime']?.idle()
    await manager.retiredSettled()
    db.close()
  }
  const teardown = async () => {
    await stop()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
  try {
    await manager.whenRestored()
    const created = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    if (!created.ok) throw new Error(created.error)
    const lead = created.session.id
    // Fixture genesis only: write ordinary approved plan records and a consistent Start/attempt pin
    // through their stores. Dispatch and everything after it use the running manager and router.
    const addRevision = (planId: string, old: number | null) => {
      const planStore = manager.plans.store
      const content = normalizePlanContent(planInput({ ...LEAD_ROLES, approach: old ? 'Reviewed second revision' : 'Original approved revision' }))
      const contentHash = hashPlanRevision(content, null)
      const revision = planStore.insertRevision(planId, { content, contentHash, pin: null, author: HUMAN })
      if (old !== null) planStore.setRevisionStatus(planId, old, 'superseded')
      planStore.setRevisionStatus(planId, revision, 'approved')
      planStore.setCurrentApproved(planId, revision)
      return { revision, contentHash }
    }
    const addPlan = (title: string) => {
      const planId = manager.plans.store.insertPlan({ teamId: team.teamId, title, creator: HUMAN })
      return { planId, ...addRevision(planId, null) }
    }
    const plan = addPlan('Export plan')
    const approved = addRevision(plan.planId, plan.revision)
    const task = manager.tasks.store.create({
      teamId: team.teamId, title: 'Export CSV', direction: 'Build initial export', acceptance: 'Export rows',
      creator: SYSTEM_ACTOR, planId: plan.planId, planChange: 'api', worktree: feature, contract: CONTRACT,
    })
    const assigned = await routed('team-task-result', { type: 'team-task-assign', teamPath, requestId: 'assign', taskId: task.id,
      target: { kind: 'group', id: 'middle-devs' }, instruction: 'Build the initial CSV', requestKey: 'initial-holder' })
    if (!assigned.assignment?.messageId) throw new Error(assigned.error ?? 'The initial assignment did not record mail')
    const messageId = assigned.assignment.messageId
    await waitFor(() => manager.mailbox.store.get(messageId)?.state === 'delivered', 'the holder instruction')
    const holder = manager.mailbox.store.get(messageId)!.claimedBy!
    await waitFor(() => servers.has(feature), 'the holder MCP registry')

    const executions = new ExecutionStore(db.db)
    const execution = executions.insertExecution({
      teamId: team.teamId, planId: plan.planId, revision: plan.revision, contentHash: plan.contentHash,
      reportId: 'fixture-validation', inputHash: '1'.repeat(64), landingMode: 'direct',
      baseBranch: 'master', baseCommit: pinnedCommit, floor: {
        version: FLOOR_VERSION, map: Object.fromEntries(CI_FLOOR_CHECKS.map(check => [check, [check]])) as FloorMap,
      }, maxParallel: 1, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
    })
    db.db.query(`UPDATE plan_execution_changes SET state = 'implementing', task_id = ?, worktree = ?, branch = 'feature',
      baseline_commit = ?, generation = 1 WHERE execution_id = ? AND change = 'api'`).run(task.id, feature, pinnedCommit, execution.id)
    new ExecutionRevisionStore(db.db).recordAt(1, {
      executionId: execution.id, revision: plan.revision, contentHash: plan.contentHash, reportId: execution.reportId,
      inputHash: execution.inputHash, rationale: null, commandId: null, payload: null, appliedAt: execution.startedAt,
    }, [])
    const manifest: AttemptManifest = {
      version: 1, execution: execution.id, plan: { id: plan.planId, revision: plan.revision, contentHash: plan.contentHash },
      task: { id: task.id, revision: 1 }, validation: { reportId: execution.reportId, inputHash: execution.inputHash },
      baseline: pinnedCommit, startCommit: pinnedCommit, artifacts: {}, roleProfiles: [],
    }
    const attempt = executions.insertAttempt({
      executionId: execution.id, change: 'api', kind: 'implement', assignmentId: assigned.assignment.id,
      manifest, manifestHash: hashManifest(manifest),
    })
    if (!(await manager.start(lead)).ok) throw new Error('The non-spawned Lead did not start')
    await waitFor(() => servers.has(repo), 'the Lead MCP registry')

    const sendFocus = async (focus: Focus) => {
      const sourcePlanId = focus === 'other-plan' ? addPlan('Unrelated plan').planId : plan.planId
      const other = manager.tasks.store.create({
        teamId: team.teamId, title: `Focus ${focus}`, direction: 'Unrelated task direction', creator: HUMAN,
        ...(focus === 'unlinked' ? {} : { planId: sourcePlanId, planChange: focus === 'sibling' ? 'ui' : 'api' }),
      })
      const sent = await tool<{ id: string }>(feature, 'send_message', { to_kind: 'session', to_id: lead, body: `Task focus ${focus}`, task_id: other.id })
      await waitFor(() => manager.mailbox.store.get(sent.id)?.state === 'delivered' && db.getChatSession(lead)?.taskId === other.id,
        `task mail to change the Lead's focus to ${focus}`)
      return { other, messageId: sent.id }
    }
    const startHolder = async () => {
      const restored = manager.restore(holder)
      if (!restored.ok) throw new Error(restored.error)
      const started = await manager.start(holder)
      if (!started.ok) throw new Error(started.error)
      await waitFor(() => servers.has(feature), 'the holder MCP registry')
    }
    const reopen = async () => {
      await stop()
      servers.clear()
      frames.length = 0
      db = initDatabase({ path: filename })
      manager = boot(db)
      connections = new ChatConnections(manager)
      await manager.whenRestored()
      if (!(await manager.start(lead)).ok) throw new Error('The restored Lead did not start')
      await waitFor(() => servers.has(repo), 'the restored Lead MCP registry')
    }
    const settleDelivery = async () => {
      await manager['dispatcher'].settled()
      // Claim-time git reads finish independently of the dispatcher pass.
      await waitFor(() => !db.db.prepare("SELECT 1 FROM team_messages WHERE state = 'delivered' AND claim_commit IS NULL LIMIT 1").get(),
        'claim-time revision pins')
    }
    return {
      get db() { return db }, get manager() { return manager }, frames, route, routed, teamPath, lead, holder, task, plan, approved, attempt,
      execution, initialMessageId: messageId, team, feature, repo,
      transcript, sendFocus, snapshot: () => decisionWriteSnapshot(db.db), teardown, reopen,
      startHolder,
      advanceApproval: () => addRevision(plan.planId, manager.plans.store.get(plan.planId)!.currentApprovedRevision!),
      loseReply: (requestId: string) => { lostReplies.add(requestId) },
      pauseDelivery: async () => { await manager['dispatcher'].settled(); manager['dispatcher'].close() },
      settleDelivery,
      tools: () => Object.keys(registry(repo)),
      leadTool: <T>(name: string, input: unknown) => tool<T>(repo, name, input),
      holderTool: <T>(name: string, input: unknown) => tool<T>(feature, name, input),
    }
  } catch (error) {
    await teardown()
    throw error
  }
}
