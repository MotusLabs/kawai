// The restart bench behind H-RESTART, P4 and the sweep-fault fixtures
// (owner-publication-handoff D7): a git team with two live leads, a
// migrated template database copied per case, and one process lifetime at a
// time — the database file opened and the production `SessionMailbox` over
// it, booted by `start()` as ChatSessionManager boots it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatAgentDriver } from '../../chat/provider/driver'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../../db'
import { cleanGitEnv } from '../../git/gitCommand'
import { NULL_OWNERSHIP } from '../../plans/execution/executionOwnership'
import { SessionMailbox } from '../../team/sessionMailbox'
import { SessionTeams } from '../../team/sessionTeams'
import { resolveTeam, type TeamIdentity } from '../../team/teamIdentity'

export interface Life { sdb: SessionDatabase; runtime: SessionMailbox; close: () => void }

export interface RestartBench {
  team: TeamIdentity
  records: Map<string, ChatSessionRecord>
  /** One process lifetime over `file`; `start` boots the mailbox (and its handoff sweep). */
  open: (file: string, start?: boolean) => Promise<Life>
  /** A fresh copy of the migrated template. */
  freshFile: () => string
  /** Every row the handoff paths write, in insertion order. */
  dump: (db: SessionDatabase['db']) => unknown[]
  /** What the handoff sweep may write: every handoff-path row except mail delivery state, which the mailbox's own startup reconciliation moves; the mail ids stay. */
  sweepDump: (db: SessionDatabase['db']) => unknown[]
  dispose: () => void
}

export const HANDOFF_TABLES = ['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages', 'team_task_drafts', 'team_tasks']

export async function createRestartBench(prefix: string): Promise<RestartBench> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const repo = path.join(root, 'repo')
  const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(result.stderr)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  const team = await resolveTeam(repo)
  const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
    sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  const records = new Map<string, ChatSessionRecord>([['lead', row('lead', 'leads')], ['lead2', row('lead2', 'leads')]])
  const template = path.join(root, 'template.db')
  initDatabase({ path: template }).close()
  let sequence = 0
  return {
    team, records,
    open: async (file, start = true) => {
      const sdb = initDatabase({ path: file })
      const teams = new SessionTeams({ homeDir: path.join(root, 'home') })
      for (const id of records.keys()) await teams.track(id, repo)
      const runtime = new SessionMailbox(sdb.db, {
        ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
        teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
        getDriver: () => ({ getPendingRequests: () => [], deliver: () => {} }) as unknown as ChatAgentDriver,
        prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false,
        hasRunningBackgroundTasks: () => false, transcriptFor: () => null, homeDir: path.join(root, 'home'), onError: () => {},
      })
      if (start) runtime.start()
      return { sdb, runtime, close: () => { runtime.close(); sdb.close() } }
    },
    freshFile: () => {
      const file = path.join(root, `db-${++sequence}.db`)
      fs.copyFileSync(template, file)
      return file
    },
    dump: db => HANDOFF_TABLES.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    sweepDump: db => [
      ...HANDOFF_TABLES.filter(table => table !== 'team_messages').map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      db.prepare('SELECT id, to_kind, to_id, tags, body FROM team_messages ORDER BY rowid').all(),
    ],
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}
