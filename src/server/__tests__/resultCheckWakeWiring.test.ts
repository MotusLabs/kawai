// The production submit wake (independent-verification D1, review
// findings-66e79a5b B4): the composition wires TaskResultService's onResult
// to its ResultCheckService (sessionMailbox.ts), so a submitted result's
// pending row runs with no manual wake — deleting the post-commit
// `onResult?.(...)` leaves the row pending and fails here. The recheck wake
// rides the same composition. A real git repository is the team, so the
// check runs its real git path end to end.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { schemaDb } from './schemaDb'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import { cleanGitEnv } from '../git/gitCommand'
import type { TaskCaller } from '../team/TaskService'

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let dir: string
let db: Database
let runtime: SessionMailbox
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-check-wake-')))
  git(['init', '-q', '--initial-branch=master', dir])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.mkdirSync(path.join(dir, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai/groups/devs.md'), 'Build features')
  fs.writeFileSync(path.join(dir, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  db = schemaDb(':memory:')
  const records = new Map<string, ChatSessionRecord>()
  for (const [id, group] of [['lead', 'leads'], ['dev', 'devs']] as const) {
    records.set(id, { sessionId: id, groupId: group, projectPath: dir, name: id, sdkSessionId: null,
      status: 'waiting', createdAt: '', lastActivityAt: '' } as ChatSessionRecord)
  }
  const teams = new SessionTeams({ homeDir: dir })
  await teams.track('lead', dir)
  await teams.track('dev', dir)
  runtime = new SessionMailbox(db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
    getDriver: id => ({ getPendingRequests: () => [], deliver: () => { records.get(id)!.status = 'working' } }) as unknown as ChatSessionDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }),
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false, transcriptFor: () => null,
    homeDir: dir, onError: error => { throw error },
  })
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

// @covers: specs/task-results "Result checks never block or gate"
test('the composition wakes the check service: a submitted result settles with no manual wake, and its recheck too', async () => {
  const task = await runtime.tasks.create(agent('lead'), { title: 'Wired', direction: 'v1' })
  // Submit through the real service the mailbox owns; nothing in this test
  // ever calls wake() itself — the composition's onResult must do it.
  const result = await runtime.results.submit(agent('dev'), task.id, { summary: 'CSV export', commit: 'abc123' })
  expect(runtime.tasks.store.checks.pendingForResult(result.id)).toMatchObject({ status: 'pending', trigger: 'submit' })
  await runtime.resultChecks.quiesce()
  expect(runtime.tasks.store.checks.pendingForResult(result.id)).toBeNull()
  const stored = runtime.tasks.store.checks.allForResult(result.id)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({ status: 'done', trigger: 'submit' })
  // The real repository is checked: the given text is no commit there.
  expect(stored[0]?.facts?.commit).toMatchObject({ status: 'fail', note: 'commit not found' })
  // The recheck rides the composition's onRecheck the same way.
  const rechecked = await runtime.results.recheck(agent('dev'), task.id, result.id)
  await runtime.resultChecks.quiesce()
  expect(runtime.tasks.store.checks.get(rechecked.id)).toMatchObject({ status: 'done', trigger: 'recheck' })
  expect(runtime.tasks.store.checks.allForResult(result.id)).toHaveLength(2)
})
