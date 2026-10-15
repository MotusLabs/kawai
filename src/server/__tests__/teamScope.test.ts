import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { cleanGitEnv } from '../git/gitCommand'
import { MailboxStore } from '../team/mailboxStore'
import type { ServerMessage } from '../../shared/types'
import { SessionTeams } from '../team/sessionTeams'
import { TeamScopes } from '../team/teamScope'
import { clearTeamCache } from '../team/teamIdentity'

// cleanGitEnv: under the pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE,
// and a raw spawn would run these commands against the hook's repository.
function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

describe('TeamScopes', () => {
  let root: string
  let repo: string
  let worktree: string
  let chatRepo: string
  let plain: string
  let unrelated: string

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-scope-')))
    repo = path.join(root, 'repo')
    worktree = path.join(root, 'repo-feature')
    chatRepo = path.join(root, 'chat-repo')
    plain = path.join(root, 'plain')
    unrelated = path.join(root, 'unrelated')
    for (const dir of [repo, chatRepo, unrelated]) {
      git(['init', '-q', dir])
      git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
    }
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], repo)
    fs.mkdirSync(plain)
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  beforeEach(() => clearTeamCache())

  const scopes = (teams: SessionTeams, repositories: string[] = []) => new TeamScopes({ teams, repositories: () => repositories })

  test('a discovered repository is addressable by its main checkout and its worktrees, with no chat', async () => {
    const teams = new SessionTeams()
    const scope = scopes(teams, [path.join(repo, '.git')])
    const main = await scope.resolve(repo)
    expect(main).toEqual({ teamId: path.join(repo, '.git'), groupsRoot: repo })
    expect(await scope.resolve(worktree)).toEqual(main)
  })

  test('a chat session’s team is addressable, including a plain directory', async () => {
    const teams = new SessionTeams()
    teams.track('s1', chatRepo)
    teams.track('s2', plain)
    const scope = scopes(teams)
    expect((await scope.resolve(chatRepo))?.teamId).toBe(path.join(chatRepo, '.git'))
    expect(await scope.resolve(plain)).toEqual({ teamId: plain, groupsRoot: plain })
  })

  test('an archived chat still counts: only a kill forgets its team', async () => {
    const teams = new SessionTeams()
    await teams.track('archived', chatRepo)
    const scope = scopes(teams)
    expect(await scope.resolve(chatRepo)).toBeDefined()
    teams.forget('archived')
    expect(await scope.resolve(chatRepo)).toBeUndefined()
  })

  test('an unrelated directory is refused', async () => {
    const teams = new SessionTeams()
    teams.track('s1', chatRepo)
    const scope = scopes(teams, [path.join(repo, '.git')])
    expect(await scope.resolve(unrelated)).toBeUndefined()
    expect(await scope.resolve(path.join(root, 'missing'))).toBeUndefined()
  })

  test('relative and non-string paths are refused', async () => {
    const scope = scopes(new SessionTeams(), [path.join(repo, '.git')])
    expect(await scope.resolve('repo')).toBeUndefined()
    expect(await scope.resolve(undefined)).toBeUndefined()
    expect(await scope.resolve(42)).toBeUndefined()
  })

  test('over the connection: a repository with no chat opens by its checkout or a worktree, and changes reach both views', async () => {
    const db = new Database(':memory:')
    const store = new MailboxStore(db)
    const teamId = path.join(repo, '.git')
    const manager = {
      whenRestored: () => Promise.resolve(),
      teamScopes: scopes(new SessionTeams(), [teamId]),
      mailbox: { store }, dispatcher: { notify: () => {} },
      routingState: () => ({ rules: null, decisions: [] }), teamRoster: () => [], waitingFor: () => ({}),
    } as unknown as ChatSessionManager
    const connections = new ChatConnections(manager)
    store.subscribe((team, message) => connections.publishMailbox(team, message))
    const sent: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => { sent.push(message) } }
    await connections.handle(connection, { type: 'team-mailbox-open', teamPath: repo })
    await connections.handle(connection, { type: 'team-mailbox-open', teamPath: worktree })
    expect(sent.map(message => message.type === 'team-mailbox-snapshot' && [message.teamPath, message.teamId]))
      .toEqual([[repo, teamId], [worktree, teamId]])
    store.enqueue({ teamId, fromSession: 'lead', fromGroup: null, toKind: 'group', toId: 'devs', originPath: repo, body: 'Work' })
    expect(sent.slice(2).map(message => message.type === 'team-mailbox-snapshot' && message.teamPath)).toEqual([repo, worktree])
    await connections.handle(connection, { type: 'team-mailbox-open', teamPath: unrelated })
    expect(sent.at(-1)).toEqual({ type: 'error', message: `unknown-team: ${unrelated}` })
    db.close()
  })
})
