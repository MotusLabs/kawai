// owner-publication-handoff CP1 (tasks 3.3, 4.2) through the production
// composition: a Lead chat's own kawai-team server records a publication
// request for a Kawai task whose holder claimed it; the workspace snapshot
// lists the human-owned W2 item; an ordinary publish under a reserved
// `handoff:` key (bare or padded, with a blank rationale, and from a persisted
// draft linked to the handoff) is refused first, writes nothing and leaves W2
// in a fresh snapshot; the human's `team-task-handoff-publish` publishes
// revision 2 with the handoff's association, and its one notice and one
// requester wakeup are delivered to the holder and the Lead; W2 clears; a
// resend replays with every row unchanged; a request on the old base is
// refused naming the current revision; and a padded ordinary key publishes
// under its one canonical value, which a differently padded resend replays.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { cleanGitEnv } from '../git/gitCommand'
import { resolveTeam } from '../team/teamIdentity'
import { RESERVED_KEY_REFUSAL } from '../team/taskHandoffService'
import { SYSTEM_ACTOR } from '../../shared/team'
import { handleMessage, type MessageRouterContext } from '../ws/messageRouter'
import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { AttentionItem } from '../../shared/teamWorkspace'

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>
type Workspace = Extract<ServerMessage, { type: 'team-workspace-snapshot' | 'team-workspace' }>

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// @covers: task-publication-handoffs › Task authors may request an owner publication › A Lead prepares a correction for a Kawai task
// @covers: team-workspace › The attention queue lists pending publication handoffs › A Kawai task's handoff needs the human
// @covers: task-publication-handoffs › The publisher publishes a handoff with one action › The human publishes a prepared correction
// @covers: task-publication-handoffs › Each disposition wakes the next actor once › The requester learns of the publication
// @covers: task-publication-handoffs › Each disposition wakes the next actor once › A replay sends nothing more
// @covers: task-publication-handoffs › A handoff is published at most once › A handoff key is refused before other checks
// @covers: task-publication-handoffs › A request is validated before it is recorded › A stale base is refused
// @covers: task-publication-handoffs › A handoff is published at most once › Surrounding whitespace does not hide a handoff key
// @covers: task-publication-handoffs › A handoff is published at most once › A padded ordinary key works as before
// @covers: task-publication-handoffs › A handoff is published at most once › A linked draft cannot take a handoff's key
// @covers: task-publication-handoffs › A handoff is published at most once › An ordinary publication cannot take a handoff's key
test('a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-publish-')))
  const repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  const feature = path.join(root, 'feature')
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nprofiles: [sonnet]\nmax: 3\n---\nBuild features')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nCoordinate work')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const servers = new Map<string, Options['mcpServers']>()
  let connections: ChatConnections | null = null
  const manager = new ChatSessionManager({
    onMailboxChange: (teamId, message) => connections?.publishMailbox(teamId, message),
    onWaitingReasonsChange: teamId => connections?.publishMailbox(teamId),
    onTaskChange: teamId => connections?.publishTasks(teamId),
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: params => {
      if (!servers.has(params.options.cwd ?? '')) servers.set(params.options.cwd ?? '', params.options.mcpServers)
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
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
        yield* fixture
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  const pushed: ServerMessage[] = []
  connections = new ChatConnections(manager)
  const connection = { send: (message: ServerMessage) => { pushed.push(message) } }
  const send = (message: ClientMessage) => connections!.handle(connection, message)
  const answer = (requestId: string) =>
    pushed.find(message => message.type === 'team-task-result' && message.requestId === requestId) as Extract<ServerMessage, { type: 'team-task-result' }>
  // The human's publish commands go through the real WS router (its forward list), as the app sends them.
  const router = { hub: { send: () => {} }, chatConnections: connections, chatPeer: () => connection } as unknown as MessageRouterContext
  const routed = async (message: Extract<ClientMessage, { requestId: string }>) => {
    handleMessage(router, {} as ServerWebSocket<never>, JSON.stringify(message))
    await waitFor(() => !!answer(message.requestId), `the answer to ${message.type}`)
    return answer(message.requestId)
  }
  // A workspace open through the same router; resolves on a snapshot pushed after it.
  const openWorkspace = async () => {
    const seen = pushed.length
    handleMessage(router, {} as ServerWebSocket<never>, JSON.stringify({ type: 'team-workspace-open', teamPath: repo }))
    await waitFor(() => pushed.slice(seen).some(message => message.type === 'team-workspace-snapshot' || message.type === 'team-workspace'), 'a fresh workspace snapshot')
  }
  const handoffItems = () => {
    const latest = pushed.filter((message): message is Workspace => message.type === 'team-workspace-snapshot' || message.type === 'team-workspace').at(-1)
    return latest?.attention.filter(item => item.kind === 'publication-handoff') ?? []
  }
  const rows = (sql: string) => db.db.prepare(sql).all()
  const snapshot = () => ({
    handoffs: rows('SELECT * FROM team_task_handoffs ORDER BY id'),
    events: rows('SELECT * FROM team_task_handoff_events ORDER BY handoff_id, seq'),
    wakeups: rows('SELECT * FROM team_task_handoff_wakeups ORDER BY handoff_id, transition'),
    revisions: rows('SELECT * FROM team_task_revisions ORDER BY task_id, revision'),
    notices: rows('SELECT * FROM team_task_notifications ORDER BY id'),
    messages: rows('SELECT * FROM team_messages ORDER BY id'),
    drafts: rows('SELECT * FROM team_task_drafts ORDER BY task_id'),
  })
  try {
    await manager.whenRestored()
    const team = await resolveTeam(repo)
    // A Kawai task: no agent owner, so its handoff waits on the human (W2).
    const task = manager.tasks.store.create({ teamId: team.teamId, title: 'Export CSV', direction: 'CSV export', creator: SYSTEM_ACTOR, worktree: feature })
    // The Lead's main-checkout session also makes the repository a known team.
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    if (!lead.ok) throw new Error(lead.error)

    // The holder: the human assigns the task; a spawned devs member claims it.
    await send({ type: 'team-task-assign', teamPath: repo, requestId: 'assign', taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build the export', requestKey: 'assign-1' })
    expect(answer('assign').error).toBeUndefined()
    const [instruction] = manager.mailbox.store.forTask(task.id)
    await waitFor(() => manager.mailbox.store.get(instruction!.id)?.state === 'delivered', 'the instruction delivered')
    const holder = manager.mailbox.store.get(instruction!.id)!.claimedBy!

    // The Lead chat, started through the manager: its own kawai-team server.
    servers.delete(repo)
    expect((await manager.start(lead.session.id)).ok).toBe(true)
    await waitFor(() => servers.has(repo), 'the lead\'s agent start')
    const tools = ((servers.get(repo)!['kawai-team'] as { instance: unknown }).instance as { _registeredTools: Registered })._registeredTools
    const call = async (name: string, input: unknown) => {
      const reply = await tools[name]!.handler(input, {})
      return { error: reply.isError ? reply.content[0]!.text : null, text: reply.content[0]!.text }
    }
    await openWorkspace()
    expect(handoffItems()).toEqual([])

    // 1. The Lead requests a publication of revision 1 (H1): open, task unchanged.
    const request = { task_id: task.id, base_revision: 1, direction: 'CSV export with headers', acceptance: 'Headers in row one', rationale: 'Review found missing headers', request_key: 'fix-headers' }
    const requested = await call('task_request_publication', request)
    expect(requested.error).toBeNull()
    const handoffId = JSON.parse(requested.text).handoff.id as string
    expect(JSON.parse(requested.text).handoff).toMatchObject({ state: 'open', baseRevision: 1, notify: true, requesterSession: lead.session.id, requesterGroup: 'leads' })
    expect(manager.tasks.store.get(task.id)!.revision).toBe(1)
    expect(rows('SELECT COUNT(*) AS n FROM team_task_notifications')).toEqual([{ n: 0 }])

    // 2. W2: the human owns the item, with the publish action and the handoff link.
    await connections.flushWorkspace()
    const w2: AttentionItem[] = [{
      id: `publication-handoff:${handoffId}`, kind: 'publication-handoff',
      cause: `Prepared revision on revision 1 awaits publication (requested by ${lead.session.name})`,
      owner: { kind: 'human', id: null, label: 'Human' }, impact: { taskId: task.id, taskTitle: 'Export CSV' },
      nextAction: 'Publish prepared revision', link: { kind: 'task', id: task.id, handoffId }, requiresHuman: true,
    }]
    expect(handoffItems()).toEqual(w2)

    // 3. The human's saved draft, linked to H (the load command is a later
    // wave, so only the link columns are seeded on the real saved row).
    expect((await routed({ type: 'team-task-draft', teamPath: repo, requestId: 'draft', taskId: task.id, action: 'save', baseRevision: 1, direction: 'Edited from the handoff', rationale: 'edit' })).error).toBeUndefined()
    db.db.prepare('UPDATE team_task_drafts SET handoff_id = ?, lineage_id = ? WHERE task_id = ?').run(handoffId, 'lineage-1', task.id)
    expect(rows(`SELECT direction, handoff_id, lineage_id FROM team_task_drafts WHERE task_id = '${task.id}'`)).toEqual([{ direction: 'Edited from the handoff', handoff_id: handoffId, lineage_id: 'lineage-1' }])

    // An ordinary publish under the reserved key, bare or padded, without the
    // draft (H33) and from the linked draft (H33d), is refused before the
    // blank-rationale requirement; nothing is written, and a fresh snapshot
    // still lists W2.
    const before = snapshot()
    const reserved = [`handoff:${handoffId}`, ` handoff:${handoffId}`, `\thandoff:${handoffId}\n`, `handoff:${handoffId}  `]
    for (const fromDraft of [false, true]) {
      for (const [index, key] of reserved.entries()) {
        const refused = await routed({
          type: 'team-task-publish', teamPath: repo, requestId: `reserved-${fromDraft}-${index}`, taskId: task.id, baseRevision: 1, requestKey: key,
          direction: fromDraft ? 'Edited from the handoff' : 'Other', rationale: ' ', notify: false, ...(fromDraft ? { fromDraft: true } : {}),
        })
        expect(refused.error).toBe(RESERVED_KEY_REFUSAL)
      }
    }
    expect(snapshot()).toEqual(before)
    expect(manager.tasks.handoffs.store.get(handoffId)!.state).toBe('open')
    await openWorkspace()
    expect(handoffItems()).toEqual(w2)

    // 4. The human publishes the prepared revision (H12).
    const publish = await routed({ type: 'team-task-handoff-publish', teamPath: repo, requestId: 'publish', taskId: task.id, handoffId, requestKey: 'publish-1' })
    expect(publish.error).toBeUndefined()
    expect(publish).toMatchObject({ revision: 2, replay: false })
    const revision = manager.tasks.store.revisions(task.id).at(-1)!
    expect([revision.revision, revision.direction, revision.acceptance, revision.rationale, revision.author.kind]).toEqual([2, 'CSV export with headers', 'Headers in row one', 'Review found missing headers', 'human'])
    expect(rows(`SELECT revision, request_key, handoff_id FROM team_task_revisions WHERE task_id = '${task.id}' AND revision = 2`)).toEqual([{ revision: 2, request_key: `handoff:${handoffId}`, handoff_id: handoffId }])
    expect(manager.tasks.handoffs.store.get(handoffId)).toMatchObject({ state: 'published', publishedRevision: 2, stateActor: { kind: 'human', sessionId: null } })
    // One notice, to the claimed holder.
    const notices = rows('SELECT recipient_session, revision, message_id FROM team_task_notifications') as Array<{ recipient_session: string; revision: number; message_id: string }>
    expect(notices.map(row => [row.recipient_session, row.revision])).toEqual([[holder, 2]])
    // One wakeup, direct to the live requester, with no task attachment.
    const wakeups = rows('SELECT transition, message_id FROM team_task_handoff_wakeups') as Array<{ transition: string; message_id: string }>
    expect(wakeups.map(row => row.transition)).toEqual(['published'])
    const wakeup = manager.mailbox.store.get(wakeups[0]!.message_id)!
    expect([wakeup.toKind, wakeup.toId, wakeup.taskId ?? null, wakeup.tags]).toEqual(['session', lead.session.id, null, ['publication-handoff', 'handoff-published']])
    expect(wakeup.body).toContain(handoffId)
    expect(wakeup.body).toContain('revision 2')
    // Both reach their recipients: the dispatcher delivers each to that session
    // (delivery is confirmed by the recipient's transcript carrying the id).
    const delivered = (id: string) => manager.mailbox.store.get(id)?.state === 'delivered'
    await waitFor(() => delivered(notices[0]!.message_id) && delivered(wakeup.id), 'the notice and the wakeup delivered')
    expect([notices[0]!.message_id, wakeup.id].map(id => manager.mailbox.store.get(id)!.claimedBy)).toEqual([holder, lead.session.id])
    // The linked draft is not this publication's: it stays.
    expect(rows(`SELECT handoff_id FROM team_task_drafts WHERE task_id = '${task.id}'`)).toEqual([{ handoff_id: handoffId }])

    // 5. W2 clears.
    await connections.flushWorkspace()
    expect(handoffItems()).toEqual([])

    // 6. A resend replays (H14): the same revision, every row unchanged.
    const published = snapshot()
    expect(await routed({ type: 'team-task-handoff-publish', teamPath: repo, requestId: 'resend', taskId: task.id, handoffId, requestKey: 'publish-1' }))
      .toMatchObject({ revision: 2, replay: true })
    expect(snapshot()).toEqual(published)

    // 7. A request on the old base is refused naming revision 2 (H2); nothing recorded.
    const stale = await call('task_request_publication', { ...request, request_key: 'fix-again' })
    expect(stale.error).toContain('current revision is 2')
    expect(snapshot()).toEqual(published)
    // Nothing more about H ever reached either recipient.
    const since = [manager.mailbox.store.get(notices[0]!.message_id)!.createdAt, wakeup.createdAt].sort()[0]
    expect(rows(`SELECT id FROM team_messages WHERE to_id IN ('${holder}', '${lead.session.id}') AND created_at >= '${since}' ORDER BY id`))
      .toEqual([notices[0]!.message_id, wakeup.id].sort().map(id => ({ id })))

    // 8. The ordinary entry, through the router: a blank rationale is still
    // refused, and a padded key publishes under its one canonical value, which
    // a differently padded resend replays.
    const ordinary = { type: 'team-task-publish' as const, teamPath: repo, taskId: task.id, baseRevision: 2, direction: 'CSV v3', rationale: 'Ordinary edit', notify: false }
    expect((await routed({ ...ordinary, requestId: 'blank', requestKey: 'plain-1', rationale: '  ' })).error).toBe('A publication needs a rationale')
    expect(await routed({ ...ordinary, requestId: 'plain', requestKey: '  plain-1  ' })).toMatchObject({ revision: 3, replay: false })
    expect(await routed({ ...ordinary, requestId: 'plain-resend', requestKey: '\tplain-1' })).toMatchObject({ revision: 3, replay: true })
    expect(rows(`SELECT revision, request_key FROM team_task_revisions WHERE task_id = '${task.id}' AND revision = 3`)).toEqual([{ revision: 3, request_key: 'plain-1' }])
  } finally {
    manager.shutdown()
    db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
