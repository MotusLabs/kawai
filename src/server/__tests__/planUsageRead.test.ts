// Plan usage read (plan-supervision 4.4): a plan's linked tasks plus its fix
// and correction tasks, summed by (group, profile) and by change, with fix
// tasks as their own rows; another plan's tasks and task-less turns excluded.
import { beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { readPlanUsage } from '../plans/supervision/planUsageRead'
import { PLAN_USAGE_NOTES } from '../../shared/planUsage'
import { schemaDb } from './schemaDb'

let db: Database
let turn = 0
beforeEach(() => {
  db = schemaDb()
  turn = 0
  task('task-api', 't', 'p', 'api')
  task('task-ui', 't', 'p', 'ui')
  task('task-other', 't', 'q', 'api')
  task('task-fix', 't', null, null)
  task('task-loose', 't', null, null)
  db.prepare(`INSERT INTO plan_fix_tasks (task_id, team_id, plan_id, source_kind, source_id, created_at) VALUES ('task-fix', 't', 'p', 'override', 'o1', 'now')`).run()
})

function task(id: string, team: string, plan: string | null, change: string | null): void {
  db.prepare(`INSERT INTO team_tasks (id, team_id, title, status, creator_kind, revision, created_at, updated_at, plan_id, plan_change)
    VALUES (?, ?, 'T', 'open', 'human', 1, 'now', 'now', ?, ?)`).run(id, team, plan, change)
}

function usage(taskId: string | null, group: string, profile: string, tokens: number, steps = 1, team = 't'): void {
  turn += 1
  db.prepare(`INSERT INTO chat_turn_usage (session_id, turn_id, team_id, group_id, profile_id, model, task_id, start_id, ok, input_tokens,
    output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, ended_at) VALUES ('s', ?, ?, ?, ?, 'm', ?, NULL, 1, ?, ?, ?, ?, ?, ?)`)
    .run(`turn-${turn}`, team, group, profile, taskId, tokens, tokens * 2, tokens * 3, tokens * 4, steps, `2026-10-19T00:00:${String(turn).padStart(2, '0')}.000Z`)
}

test('two profiles of one role sum apart, and by change in plan order', () => {
  usage('task-api', 'middle-devs', 'glm', 10, 3)
  usage('task-api', 'middle-devs', 'sonnet', 20, 2)
  usage('task-ui', 'middle-devs', 'glm', 5, 1)
  const view = readPlanUsage(db, 't', 'p', ['ui', 'api'])
  expect(view.byGroupProfile).toEqual([
    { group: 'middle-devs', profile: 'glm', turns: 2, steps: 4, inputTokens: 15, outputTokens: 30, cacheReadTokens: 45, cacheCreationTokens: 60 },
    { group: 'middle-devs', profile: 'sonnet', turns: 1, steps: 2, inputTokens: 20, outputTokens: 40, cacheReadTokens: 60, cacheCreationTokens: 80 },
  ])
  expect(view.byChange.map(row => [row.kind === 'change' ? row.change : row.taskId, row.turns, row.inputTokens])).toEqual([['ui', 1, 5], ['api', 2, 30]])
  expect(view.total).toEqual({ turns: 3, steps: 6, inputTokens: 35, outputTokens: 70, cacheReadTokens: 105, cacheCreationTokens: 140 })
  expect(view.notes).toEqual(PLAN_USAGE_NOTES)
})

test('a fix task is its own row', () => {
  usage('task-api', 'middle-devs', 'glm', 10)
  usage('task-fix', 'senior-devs', 'opus', 7)
  const view = readPlanUsage(db, 't', 'p', ['api'])
  expect(view.byChange).toEqual([
    { kind: 'change', change: 'api', turns: 1, steps: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
    { kind: 'fix', taskId: 'task-fix', sourceKind: 'override', turns: 1, steps: 1, inputTokens: 7, outputTokens: 14, cacheReadTokens: 21, cacheCreationTokens: 28 },
  ])
})

test("another plan's tasks, task-less turns, and unlinked tasks are excluded", () => {
  usage('task-other', 'middle-devs', 'glm', 100)
  usage(null, 'lead', 'opus', 100)
  usage('task-loose', 'middle-devs', 'glm', 100)
  usage('task-api', 'middle-devs', 'glm', 1)
  const view = readPlanUsage(db, 't', 'p')
  expect(view.total.turns).toBe(1)
  expect(view.total.inputTokens).toBe(1)
  expect(readPlanUsage(db, 't', 'q').total.inputTokens).toBe(100)
})

test("another team's read sees nothing of the plan", () => {
  usage('task-api', 'middle-devs', 'glm', 10)
  usage('task-fix', 'senior-devs', 'opus', 7)
  expect(readPlanUsage(db, 'other', 'p').total.turns).toBe(0)
})

test("a turn recorded under another team is excluded, even when pinned to this plan's task", () => {
  usage('task-api', 'middle-devs', 'glm', 10)
  usage('task-api', 'middle-devs', 'glm', 99, 1, 'other')
  usage('task-fix', 'senior-devs', 'opus', 99, 1, 'other')
  expect(readPlanUsage(db, 't', 'p').total).toMatchObject({ turns: 1, inputTokens: 10 })
})
