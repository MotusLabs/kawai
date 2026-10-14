// Member release end to end with fixture agents in one temporary repository
// with linked worktrees (team-member-release 7.3): closing a task releases
// its idle spawned member — archived through the real manager path, with a
// kawai-authored journal entry — and the freed capacity serves a second
// task's queued instruction, which spawns in its own worktree.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 20_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

test('closing a task releases its spawned member and frees capacity for the next task', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-release-integration-')))
  const repo = path.join(root, 'repo')
  const featX = path.join(root, 'feat-x')
  const featY = path.join(root, 'feat-y')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-y', featY], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 1\n---\nBuild features')
  const dbPath = path.join(root, 'sessions.db')
  const manager = new ChatSessionManager({
    db: initDatabase({ path: dbPath }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: () => {},
    queryFactory: params => {
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
  const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db
  try {
    await manager.whenRestored()
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }

    // One task with its spawned member settled in feat-x.
    const first = await manager.tasks.create(human, { title: 'First feature', direction: 'Build it', worktree: featX })
    const firstDispatch = await manager.assignments.dispatch(human, {
      taskId: first.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build the first feature', requestKey: 'intent-1',
    })
    await waitFor(() => manager.mailbox.store.get(firstDispatch.message!.id)?.state === 'delivered', 'first delivery')
    const member = manager.mailbox.store.get(firstDispatch.message!.id)!.claimedBy!
    expect(db().getChatSessions().find(row => row.sessionId === member)).toMatchObject({ spawned: true, taskId: first.id })
    await waitFor(() => manager.getSnapshot(member)?.status === 'waiting', 'member idle again')

    // The group is at max: a second task's instruction queues without a spawn.
    const second = await manager.tasks.create(human, { title: 'Second feature', direction: 'Build it too', worktree: featY })
    const secondDispatch = await manager.assignments.dispatch(human, {
      taskId: second.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build the second feature', requestKey: 'intent-2',
    })
    await waitFor(() => manager.mailbox.store.get(secondDispatch.message!.id)?.state === 'queued', 'second instruction queued')
    expect(db().getChatSessions().filter(row => row.spawned && row.archivedAt == null)).toHaveLength(1)

    // Closing the first task releases its member: archived, never killed,
    // with kawai's journal entries on the task (the close, then the release).
    await manager.tasks.setStatus(human, first.id, 'done')
    await waitFor(() => db().getChatSessions().find(row => row.sessionId === member)?.archivedAt != null, 'member released')
    const journal = manager.tasks.store.journal(first.id)
    expect(journal.map(entry => entry.text)).toEqual([
      'Assigned to group devs by human',
      'Task done.',
      expect.stringMatching(/^Released .+ \(.+\): task done by the human\.$/),
    ])
    expect(journal.at(-1)).toMatchObject({ author: { kind: 'system', sessionId: null } })

    // The freed capacity serves the queued instruction: a fresh member
    // spawns in feat-y for the second task and receives it.
    await waitFor(() => manager.mailbox.store.get(secondDispatch.message!.id)?.state === 'delivered', 'second delivery after release')
    const successor = manager.mailbox.store.get(secondDispatch.message!.id)!.claimedBy!
    expect(successor).not.toBe(member)
    expect(db().getChatSessions().find(row => row.sessionId === successor)).toMatchObject({ spawned: true, taskId: second.id, projectPath: featY })
  } finally {
    manager.shutdown()
    db().close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
