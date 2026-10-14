import { describe, expect, test } from 'bun:test'
import {
  anyWorkerLive,
  initialChatWorkersState,
  projectWorkers,
  recoveredWorkersState,
  reduceWorkers,
  taskFrameToInput,
  type ChatWorkersInput,
  type ChatWorkersState,
} from '../chat/chatWorkers'

// Frame shapes below are copied from sdk.d.ts
// (SDKTaskStartedMessage/SDKTaskProgressMessage/SDKTaskUpdatedMessage/
// SDKTaskNotificationMessage/SDKBackgroundTasksChangedMessage) so parser
// drift from the CLI's task frames is caught here without importing the
// SDK, per design D3's risk note.

const SESSION_ID = '1fdf8d0e-51aa-46fb-a1a8-98f7b29e675e'

const taskStartedFrame = (overrides?: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
  tool_use_id: 'toolu_01XKUDMFUEHpYGekHvc9x5Qm',
  description: 'Map the workspace structure',
  subagent_type: 'Explore',
  is_backgrounded: false,
  spawn_depth: 1,
  task_type: 'local_agent',
  uuid: '6f2f0f3d-8345-4a1f-9b62-a4c39f57dcb0',
  session_id: SESSION_ID,
  ...overrides,
})

const TASK_PROGRESS_FRAME = {
  type: 'system',
  subtype: 'task_progress',
  task_id: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
  tool_use_id: 'toolu_01XKUDMFUEHpYGekHvc9x5Qm',
  description: 'Map the workspace structure',
  subagent_type: 'Explore',
  usage: { total_tokens: 12_400, tool_uses: 6, duration_ms: 31_000 },
  last_tool_name: 'Grep',
  uuid: '9f0e2a1c-4b7d-4c8e-b1f3-2d4a5b6c7e8f',
  session_id: SESSION_ID,
}

const taskUpdatedFrame = (patch: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
  patch,
  uuid: 'c2d3e4f5-6a7b-8c9d-0e1f-2a3b4c5d6e7f',
  session_id: SESSION_ID,
})

const taskNotificationFrame = (overrides?: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
  tool_use_id: 'toolu_01XKUDMFUEHpYGekHvc9x5Qm',
  status: 'completed',
  reason: undefined,
  output_file: '/home/user/.claude/projects/-proj/subagents/agent-b01c9a58.jsonl',
  summary: 'Mapped 14 files across 3 packages',
  usage: { total_tokens: 41_200, tool_uses: 18, duration_ms: 96_000 },
  uuid: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
  session_id: SESSION_ID,
  ...overrides,
})

const backgroundTasksFrame = (
  tasks: Array<Record<string, unknown>>
) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
  uuid: 'd4e5f6a7-8b9c-0d1e-2f3a-4b5c6d7e8f9a',
  session_id: SESSION_ID,
})

const TASK_ID = 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247'
const TOOL_USE_ID = 'toolu_01XKUDMFUEHpYGekHvc9x5Qm'

/** spawn → started → (optionally more), the prefix every test begins with. */
function spawnedState(
  startedOverrides?: Record<string, unknown>,
  extra: ChatWorkersInput[] = []
): ChatWorkersState {
  let state = reduceWorkers(
    initialChatWorkersState(),
    { type: 'spawn', toolCallId: TOOL_USE_ID },
    1_000
  )
  state = reduceWorkers(
    state,
    taskFrameToInput(taskStartedFrame(startedOverrides))!,
    1_500
  )
  for (const input of extra) state = reduceWorkers(state, input, 2_000)
  return state
}

describe('taskFrameToInput', () => {
  test('maps the five task frame shapes from sdk.d.ts', () => {
    expect(taskFrameToInput(taskStartedFrame())).toEqual({
      type: 'task_started',
      taskId: TASK_ID,
      toolUseId: TOOL_USE_ID,
      agentType: 'Explore',
      description: 'Map the workspace structure',
      depth: 1,
      taskType: 'local_agent',
    })
    expect(taskFrameToInput(TASK_PROGRESS_FRAME)).toEqual({
      type: 'task_progress',
      taskId: TASK_ID,
      toolUseId: TOOL_USE_ID,
      description: 'Map the workspace structure',
      lastTool: 'Grep',
    })
    expect(
      taskFrameToInput(taskUpdatedFrame({ status: 'completed' }))
    ).toEqual({ type: 'task_updated', taskId: TASK_ID, status: 'completed' })
    expect(taskFrameToInput(taskUpdatedFrame({ is_backgrounded: true }))).toEqual(
      { type: 'task_updated', taskId: TASK_ID, backgrounded: true }
    )
    expect(taskFrameToInput(taskNotificationFrame())).toEqual({
      type: 'task_notification',
      taskId: TASK_ID,
      toolUseId: TOOL_USE_ID,
      status: 'completed',
      summary: 'Mapped 14 files across 3 packages',
      // The recorded output rides along for the background-task roster (D3);
      // the worker reducer itself ignores it.
      outputFile: '/home/user/.claude/projects/-proj/subagents/agent-b01c9a58.jsonl',
    })
    expect(
      taskFrameToInput(
        backgroundTasksFrame([
          { task_id: TASK_ID, task_type: 'local_agent', description: 'Map' },
          {
            task_id: 'ambient-1',
            task_type: 'watcher',
            description: 'watch',
            ambient: true,
          },
        ])
      )
    ).toEqual({ type: 'background_tasks', taskIds: [TASK_ID] })
  })

  test('drops non-task subtypes and unusable payloads', () => {
    expect(taskFrameToInput({ subtype: 'status', status: 'requesting' })).toBeNull()
    expect(taskFrameToInput({ subtype: 'init' })).toBeNull()
    expect(taskFrameToInput({ subtype: 'task_started' })).toBeNull()
    // A notification status outside the settle union cannot be trusted.
    expect(
      taskFrameToInput(taskNotificationFrame({ status: 'paused' }))
    ).toBeNull()
  })

  test('drops ambient and skip_transcript tasks wherever they appear', () => {
    expect(
      taskFrameToInput(taskStartedFrame({ ambient: true }))
    ).toBeNull()
    expect(
      taskFrameToInput(taskStartedFrame({ skip_transcript: true }))
    ).toBeNull()
    expect(
      taskFrameToInput(taskNotificationFrame({ ambient: true, status: 'stopped' }))
    ).toBeNull()
    // Ambient entries leave the level set too: hosts must not count them.
    expect(
      taskFrameToInput(
        backgroundTasksFrame([
          { task_id: 'w1', task_type: 'watcher', description: '', ambient: true },
        ])
      )
    ).toEqual({ type: 'background_tasks', taskIds: [] })
  })
})

describe('reduceWorkers', () => {
  test('a tool_call anchors a running live row keyed by its id', () => {
    const state = reduceWorkers(
      initialChatWorkersState(),
      { type: 'spawn', toolCallId: 'toolu_spawn_2' },
      1_000
    )
    expect(projectWorkers(state, 1_500)).toEqual([
      { workerId: 'toolu_spawn_2', status: 'running', live: true, elapsedMs: 500 },
    ])
    // Re-seeing the same call is a no-op, not a second row.
    const again = reduceWorkers(state, { type: 'spawn', toolCallId: 'toolu_spawn_2' }, 2_000)
    expect(again).toBe(state)
  })

  test('task_started fills identity fields on the anchored row', () => {
    const state = spawnedState()
    expect(projectWorkers(state, 2_000)).toEqual([
      {
        workerId: TOOL_USE_ID,
        taskId: TASK_ID,
        agentType: 'Explore',
        description: 'Map the workspace structure',
        depth: 1,
        status: 'running',
        live: true,
        elapsedMs: 1_000,
      },
    ])
  })

  test('task_started creates a row when the tool_call frame was missed', () => {
    let state = reduceWorkers(
      initialChatWorkersState(),
      taskFrameToInput(taskStartedFrame())!,
      1_000
    )
    expect(projectWorkers(state, 1_500)).toEqual([
      {
        workerId: TOOL_USE_ID,
        taskId: TASK_ID,
        agentType: 'Explore',
        description: 'Map the workspace structure',
        depth: 1,
        status: 'running',
        live: true,
        elapsedMs: 500,
      },
    ])
  })

  test('non-agent tasks and unjoinable task_started frames are not workers', () => {
    let state = initialChatWorkersState()
    // A backgrounded Bash command has a tool_use_id but no agent identity.
    state = reduceWorkers(
      state,
      taskFrameToInput(
        taskStartedFrame({
          task_id: 'bash-1',
          tool_use_id: 'toolu_bash_1',
          description: 'bun test',
          subagent_type: undefined,
          spawn_depth: undefined,
          task_type: 'local_bash',
          is_backgrounded: true,
        })
      )!,
      1_000
    )
    // No tool_use_id at all: cannot join to a row (design D3).
    state = reduceWorkers(
      state,
      taskFrameToInput(
        taskStartedFrame({ tool_use_id: undefined, subagent_type: 'Explore' })
      )!,
      1_000
    )
    expect(projectWorkers(state, 1_500)).toEqual([])
  })

  test('task_progress records the last tool and a renamed description', () => {
    const state = spawnedState()
    const next = reduceWorkers(
      state,
      taskFrameToInput({
        ...TASK_PROGRESS_FRAME,
        description: 'Map the src/ packages',
      })!,
      2_000
    )
    expect(projectWorkers(next, 2_000)).toEqual([
      {
        workerId: TOOL_USE_ID,
        taskId: TASK_ID,
        agentType: 'Explore',
        description: 'Map the src/ packages',
        depth: 1,
        status: 'running',
        live: true,
        lastTool: 'Grep',
        elapsedMs: 1_000,
      },
    ])
  })

  test('a settled task_updated writes its outcome and clears live', () => {
    for (const [patch, expected] of [
      [{ status: 'completed' }, 'completed'],
      [{ status: 'failed' }, 'failed'],
      [{ status: 'killed' }, 'stopped'],
    ] as const) {
      const state = spawnedState()
      const next = reduceWorkers(
        state,
        taskFrameToInput(taskUpdatedFrame(patch))!,
        2_000
      )
      expect(projectWorkers(next, 2_000)).toEqual([
        expect.objectContaining({ status: expected, live: false }),
      ])
    }
  })

  test('a non-settling task_updated patch leaves status and live alone', () => {
    const state = spawnedState()
    for (const status of ['pending', 'running', 'paused'] as const) {
      const next = reduceWorkers(
        state,
        taskFrameToInput(taskUpdatedFrame({ status }))!,
        2_000
      )
      expect(projectWorkers(next, 2_000)).toEqual([
        expect.objectContaining({ status: 'running', live: true }),
      ])
    }
  })

  test('a task_notification always wins over a provisional task_updated outcome', () => {
    // task_updated settles first (provisional), then the notification — the
    // authoritative edge — replaces both status and summary (design D3).
    const state = spawnedState(undefined, [
      taskFrameToInput(taskUpdatedFrame({ status: 'failed', description: 'mapping' }))!,
    ])
    const next = reduceWorkers(
      state,
      taskFrameToInput(taskNotificationFrame())!,
      3_000
    )
    expect(projectWorkers(next, 3_000)).toEqual([
      {
        workerId: TOOL_USE_ID,
        taskId: TASK_ID,
        agentType: 'Explore',
        description: 'mapping',
        depth: 1,
        status: 'completed',
        live: false,
        lastTool: undefined,
        elapsedMs: 2_000,
        summary: 'Mapped 14 files across 3 packages',
      },
    ])
  })

  test('a notification with no summary keeps the row, clears live', () => {
    const state = spawnedState()
    const next = reduceWorkers(
      state,
      taskFrameToInput(
        taskNotificationFrame({ status: 'stopped', summary: '' })
      )!,
      2_000
    )
    const [row] = projectWorkers(next, 2_000)
    expect(row).toMatchObject({ status: 'stopped', live: false })
    expect(row).not.toHaveProperty('summary')
  })

  test('background_tasks_changed writes live by membership only', () => {
    const state = spawnedState({ is_backgrounded: true })
    // The level set includes the task: live stays true (already was).
    const joined = reduceWorkers(
      state,
      taskFrameToInput(backgroundTasksFrame([
        { task_id: TASK_ID, task_type: 'local_agent', description: 'Map' },
      ]))!,
      2_000
    )
    expect(joined).toBe(state)
    // The set drops it before its notification: live only, status untouched
    // — the completion gap is one frame of not-live, never a false outcome.
    const left = reduceWorkers(
      joined,
      taskFrameToInput(backgroundTasksFrame([]))!,
      2_500
    )
    expect(projectWorkers(left, 2_500)).toEqual([
      expect.objectContaining({ status: 'running', live: false }),
    ])
    // A notification arriving after it left the set still writes its outcome.
    const settled = reduceWorkers(
      left,
      taskFrameToInput(taskNotificationFrame())!,
      3_000
    )
    expect(projectWorkers(settled, 3_000)).toEqual([
      expect.objectContaining({ status: 'completed', live: false }),
    ])
  })

  test('the level set never creates rows or touches a foreground worker', () => {
    const state = spawnedState() // foreground: is_backgrounded false
    const next = reduceWorkers(
      state,
      taskFrameToInput(backgroundTasksFrame([]))!,
      2_000
    )
    expect(next).toBe(state)
    expect(projectWorkers(next, 2_000)).toEqual([
      expect.objectContaining({ status: 'running', live: true }),
    ])
    // A set naming an unknown task still creates nothing.
    const stranger = reduceWorkers(
      next,
      taskFrameToInput(backgroundTasksFrame([
        { task_id: 'never-started', task_type: 'local_agent', description: '' },
      ]))!,
      2_000
    )
    expect(projectWorkers(stranger, 2_000)).toHaveLength(1)
  })

  test('a foreground worker moves to the background via task_updated', () => {
    const state = spawnedState()
    const moved = reduceWorkers(
      state,
      taskFrameToInput(taskUpdatedFrame({ is_backgrounded: true }))!,
      2_000
    )
    // Now governed by the set: an empty set stops showing it as live.
    const left = reduceWorkers(
      moved,
      taskFrameToInput(backgroundTasksFrame([]))!,
      2_500
    )
    expect(projectWorkers(left, 2_500)).toEqual([
      expect.objectContaining({ status: 'running', live: false }),
    ])
  })

  test('process_end settles every outcome-less worker as stopped', () => {
    let state = spawnedState(undefined, [
      taskFrameToInput(
        taskStartedFrame({
          task_id: 'task-2',
          tool_use_id: 'toolu_spawn_2',
          description: 'Index the API',
          spawn_depth: 1,
        })
      )!,
    ])
    // One worker already settled; the other is still running.
    state = reduceWorkers(
      state,
      taskFrameToInput(
        taskNotificationFrame({ status: 'failed', summary: 'boom' })
      )!,
      2_000
    )
    const ended = reduceWorkers(state, { type: 'process_end' }, 3_000)
    expect(projectWorkers(ended, 3_000)).toEqual([
      expect.objectContaining({ status: 'failed', live: false, summary: 'boom' }),
      expect.objectContaining({ workerId: 'toolu_spawn_2', status: 'stopped', live: false }),
    ])
    // An all-settled roster is untouched.
    expect(reduceWorkers(ended, { type: 'process_end' }, 4_000)).toBe(ended)
  })

  test('a notification for an unknown task changes nothing', () => {
    const state = spawnedState()
    const next = reduceWorkers(
      state,
      taskFrameToInput(
        taskNotificationFrame({ task_id: 'stranger', tool_use_id: 'toolu_x' })
      )!,
      2_000
    )
    expect(next).toBe(state)
  })

  test('a rejected spawn settles its running row as failed', () => {
    let state = reduceWorkers(
      initialChatWorkersState(),
      { type: 'spawn', toolCallId: TOOL_USE_ID },
      1_000
    )
    state = reduceWorkers(
      state,
      { type: 'spawn_rejected', toolCallId: TOOL_USE_ID, summary: 'Unknown agent type "scout"' },
      2_000
    )
    expect(projectWorkers(state, 2_500)[0]).toMatchObject({
      status: 'failed', live: false, summary: 'Unknown agent type "scout"',
    })
    expect(anyWorkerLive(state)).toBe(false)
  })

  test('spawn_rejected changes nothing without a running anchored row', () => {
    const empty = initialChatWorkersState()
    expect(reduceWorkers(empty, { type: 'spawn_rejected', toolCallId: TOOL_USE_ID }, 1_000)).toBe(empty)
    // A settled row keeps its outcome: only a still-running row may settle.
    const settled = reduceWorkers(
      spawnedState(),
      taskFrameToInput(taskNotificationFrame())!,
      2_000
    )
    expect(
      reduceWorkers(settled, { type: 'spawn_rejected', toolCallId: TOOL_USE_ID, summary: 'late' }, 2_100)
    ).toBe(settled)
  })

  test('a notification landing after a rejected spawn still wins', () => {
    let state = reduceWorkers(
      initialChatWorkersState(),
      { type: 'spawn', toolCallId: TOOL_USE_ID },
      1_000
    )
    state = reduceWorkers(
      state,
      { type: 'spawn_rejected', toolCallId: TOOL_USE_ID, summary: 'rejected' },
      2_000
    )
    state = reduceWorkers(
      state,
      taskFrameToInput(taskNotificationFrame({ status: 'completed', summary: 'late finish' }))!,
      3_000
    )
    expect(projectWorkers(state, 3_500)[0]).toMatchObject({
      status: 'completed', summary: 'late finish', live: false,
    })
  })

  test('recoveredWorkersState seeds settled rows that nothing recovers live', () => {
    const state = recoveredWorkersState([
      { workerId: 'toolu_done', taskId: 'task_done', status: 'completed', live: true, elapsedMs: 5, summary: 'mapped' },
      { workerId: 'toolu_lost', status: 'running', live: true, elapsedMs: 3 },
    ])
    const projected = projectWorkers(state, 2_000)
    expect(projected).toEqual([
      expect.objectContaining({ workerId: 'toolu_done', status: 'completed', live: false, summary: 'mapped' }),
      expect.objectContaining({ workerId: 'toolu_lost', status: 'stopped', live: false }),
    ])
    expect(anyWorkerLive(state)).toBe(false)
    // A seeded row keeps its place when a later spawn joins the roster.
    const next = reduceWorkers(state, { type: 'spawn', toolCallId: 'toolu_new' }, 2_500)
    expect(projectWorkers(next, 2_600).map((worker) => worker.workerId))
      .toEqual(['toolu_done', 'toolu_lost', 'toolu_new'])
  })
})

describe('worker projections', () => {
  test('elapsedMs is computed at projection time from the spawn clock', () => {
    const state = spawnedState()
    expect(projectWorkers(state, 61_000)[0]).toMatchObject({ elapsedMs: 60_000 })
    // Clamped: a clock skew before the spawn never reads negative.
    expect(projectWorkers(state, 500)[0]).toMatchObject({ elapsedMs: 0 })
  })

  test('anyWorkerLive reports live workers only, not the completion gap', () => {
    const state = spawnedState({ is_backgrounded: true })
    expect(anyWorkerLive(state)).toBe(true)
    const left = reduceWorkers(
      state,
      taskFrameToInput(backgroundTasksFrame([]))!,
      2_000
    )
    expect(anyWorkerLive(left)).toBe(false)
    // Still running by status — but not live, so the session is not working.
    expect(left.workers[0]).toMatchObject({ status: 'running' })
  })
})
