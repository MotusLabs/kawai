// Scenarios for the background-task roster reducer (background tasks design
// D1), one per spec scenario in "Background shell and Monitor tasks are
// tracked per chat session", plus the frame-order permutations the wire can
// produce (level set before or after the notification) and the exclusions
// (Agent workers, ambient tasks, non-shell task types).
import { describe, expect, test } from 'bun:test'
import {
  initialChatBackgroundTasksState,
  projectBackgroundTasks,
  reduceBackgroundTasks,
  type ChatBackgroundTasksInput,
  type ChatBackgroundTasksState,
} from '../chat/chatBackgroundTasks'

const T0 = 1_000
const tick = (state: ChatBackgroundTasksState, input: ChatBackgroundTasksInput, at = T0) =>
  reduceBackgroundTasks(state, input, at)

describe('chatBackgroundTasks reducer', () => {
  test('a backgrounded Bash command becomes a visible Shell task', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'tool_call', toolCallId: 'call_1', tool: 'Bash' })
    state = tick(state, {
      type: 'task_started', taskId: 'b1', toolUseId: 'call_1', taskType: 'local_bash',
      description: 'Wait for CI', background: true,
    })
    state = tick(state, { type: 'level_set', taskIds: ['b1'] })
    expect(projectBackgroundTasks(state, T0 + 5_000)).toMatchObject([
      { taskId: 'b1', toolCallId: 'call_1', kind: 'shell', description: 'Wait for CI', status: 'running', live: true, elapsedMs: 5_000 },
    ])
  })

  test('a Monitor becomes a Monitor task through the tool-call join', () => {
    let state = initialChatBackgroundTasksState()
    // The join streams before task_started, and the Monitor's task_started is
    // local_bash with is_backgrounded true (1.1 fixtures) — only the join
    // tells the two apart.
    state = tick(state, { type: 'tool_call', toolCallId: 'call_m', tool: 'Monitor' })
    state = tick(state, {
      type: 'task_started', taskId: 'b2', toolUseId: 'call_m', taskType: 'local_bash',
      description: 'errors in deploy.log', background: true,
    })
    expect(projectBackgroundTasks(state, T0)).toMatchObject([
      { taskId: 'b2', kind: 'monitor', status: 'running' },
    ])
    // The join landing after task_started resolves the kind too.
    let late = initialChatBackgroundTasksState()
    late = tick(late, { type: 'task_started', taskId: 'b2', toolUseId: 'call_m', taskType: 'local_bash', background: true })
    late = tick(late, { type: 'tool_call', toolCallId: 'call_m', tool: 'Monitor' })
    expect(projectBackgroundTasks(late, T0)).toMatchObject([{ taskId: 'b2', kind: 'monitor' }])
  })

  test('monitor_mcp and monitor_ws task types are Monitors without a join', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b3', taskType: 'monitor_ws', background: true })
    expect(projectBackgroundTasks(state, T0)).toMatchObject([{ taskId: 'b3', kind: 'monitor' }])
  })

  test('a foreground command that finishes there is never tracked', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'tool_call', toolCallId: 'call_f', tool: 'Bash' })
    state = tick(state, { type: 'task_started', taskId: 'b4', toolUseId: 'call_f', taskType: 'local_bash' })
    expect(projectBackgroundTasks(state, T0)).toEqual([])
    state = tick(state, { type: 'task_notification', taskId: 'b4', status: 'completed' })
    expect(projectBackgroundTasks(state, T0)).toEqual([])
    // And it leaves no trace in the state.
    expect(state.tasks).toEqual([])
  })

  test('a foreground command moved to the background is promoted from that point', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b5', toolUseId: 'call_5', taskType: 'local_bash', description: 'dev server' })
    expect(projectBackgroundTasks(state, T0)).toEqual([])
    state = tick(state, { type: 'task_updated', taskId: 'b5', backgrounded: true })
    expect(projectBackgroundTasks(state, T0)).toMatchObject([
      { taskId: 'b5', status: 'running', live: true },
    ])
  })

  test('a candidate is also promoted by appearing in the background set', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b6', taskType: 'local_bash' })
    state = tick(state, { type: 'level_set', taskIds: ['b6'] })
    expect(projectBackgroundTasks(state, T0)).toMatchObject([
      { taskId: 'b6', status: 'running', live: true },
    ])
  })

  test('Agent workers, ambient tasks and other task types never appear', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'a1', taskType: 'local_agent', background: true })
    state = tick(state, { type: 'task_started', taskId: 'm1', taskType: 'mcp_task', background: true })
    state = tick(state, { type: 'task_started', taskId: 'w1', taskType: 'local_workflow', background: true })
    state = tick(state, { type: 'task_started', taskId: 'am1', taskType: 'local_bash', background: true, ambient: true })
    expect(projectBackgroundTasks(state, T0)).toEqual([])
    expect(state.tasks).toEqual([])
  })

  test('a notification settles the outcome and freezes elapsed; killed reads as stopped', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b7', taskType: 'local_bash', background: true })
    state = tick(state, { type: 'task_updated', taskId: 'b7', status: 'killed' }, T0 + 8_000)
    // The patch is provisional: killed maps to stopped...
    expect(projectBackgroundTasks(state, T0 + 9_000)).toMatchObject([
      { taskId: 'b7', status: 'stopped', elapsedMs: 8_000 },
    ])
    // ...and the notification is the authority that lands after it. The
    // settle instant is the patch's (first one wins), not the report's.
    state = tick(state, { type: 'task_notification', taskId: 'b7', status: 'stopped', summary: 'Sleep for 120 seconds', outputFile: '/tmp/claude-1000/x/tasks/b7.output' }, T0 + 8_500)
    expect(projectBackgroundTasks(state, T0 + 60_000)).toMatchObject([
      { taskId: 'b7', status: 'stopped', live: false, summary: 'Sleep for 120 seconds', elapsedMs: 8_000 },
    ])
    // The output-file path stays server-side.
    expect(JSON.stringify(projectBackgroundTasks(state))).not.toContain('outputFile')
  })

  test('level set before the notification: absence ends live, the notification still settles', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b8', taskType: 'local_bash', background: true })
    state = tick(state, { type: 'level_set', taskIds: [] })
    expect(projectBackgroundTasks(state, T0 + 3_000)).toMatchObject([
      { taskId: 'b8', status: 'running', live: false },
    ])
    state = tick(state, { type: 'task_notification', taskId: 'b8', status: 'completed', summary: 'done (exit code 0)' }, T0 + 4_000)
    expect(projectBackgroundTasks(state, T0 + 99_000)).toMatchObject([
      { taskId: 'b8', status: 'completed', live: false, summary: 'done (exit code 0)', elapsedMs: 4_000 },
    ])
  })

  test('a settled entry rejoins the set briefly and keeps its outcome', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b9', taskType: 'local_bash', background: true })
    state = tick(state, { type: 'task_notification', taskId: 'b9', status: 'failed', summary: 'exit 1' }, T0 + 2_000)
    // A stale level set naming the task cannot resurrect it as running.
    state = tick(state, { type: 'level_set', taskIds: ['b9'] })
    expect(projectBackgroundTasks(state, T0 + 3_000)).toMatchObject([
      { taskId: 'b9', status: 'failed', live: true, elapsedMs: 2_000 },
    ])
  })

  test('process end settles unresolved visible entries as stopped and drops candidates', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b10', taskType: 'local_bash', background: true })
    state = tick(state, { type: 'task_started', taskId: 'c10', taskType: 'local_bash' })
    state = tick(state, { type: 'task_notification', taskId: 'b11', status: 'completed' })
    state = tick(state, { type: 'process_end', nowMs: T0 + 30_000 })
    expect(projectBackgroundTasks(state, T0 + 99_000)).toMatchObject([
      { taskId: 'b10', status: 'stopped', live: false, elapsedMs: 30_000 },
    ])
    expect(state.tasks.map((entry) => entry.taskId)).toEqual(['b10'])
  })

  test('an unknown task id in a notification or update changes nothing', () => {
    let state = initialChatBackgroundTasksState()
    state = tick(state, { type: 'task_started', taskId: 'b12', taskType: 'local_bash', background: true })
    state = tick(state, { type: 'task_notification', taskId: 'ghost', status: 'completed' })
    state = tick(state, { type: 'task_updated', taskId: 'ghost', status: 'completed' })
    expect(projectBackgroundTasks(state, T0)).toMatchObject([{ taskId: 'b12', status: 'running' }])
  })
})
