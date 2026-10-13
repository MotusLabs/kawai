// Pure reducer for a chat session's background shell and Monitor tasks
// (background tasks design D1). The driver feeds it task edges
// (task_started / task_updated / task_notification / background_tasks_changed)
// plus the Bash/Monitor tool calls they join to; the projection is the
// client-facing roster. Visibility is "backgrounded": every Bash call is a
// task on the wire — foreground ones too — so a start without
// `is_backgrounded` is only a candidate, promoted by the background flag, a
// `task_updated` patch, or membership in the background set, and discarded if
// it settles while still foreground. `live` (in the background set right now)
// and `status` (the notification's outcome) are separate, as in the worker
// roster: only `task_notification` settles an outcome, `killed` maps to
// `stopped`, and the level set only toggles `live`. Process end (driver
// death, archive, kill — not a turn interrupt) settles every unresolved
// visible entry as stopped; background shells survive an interrupted turn.
import type {
  ChatBackgroundTask,
  ChatBackgroundTaskKind,
  ChatBackgroundTaskStatus,
} from '../../shared/chat'

/** Task types that can never be a user-visible background task. */
const NON_TASK_TYPES = new Set([
  'local_agent', // Agent workers (workers design); a separate roster
  'mcp_task',
  'local_workflow',
  'in_process_teammate',
  'dream',
])

/** task_type of the shell and Monitor tasks this roster tracks. */
const MONITOR_TASK_TYPES = new Set(['monitor_mcp', 'monitor_ws'])

export interface BackgroundTaskEntry {
  taskId: string
  toolCallId?: string
  kind: ChatBackgroundTaskKind
  /** Whether the tool-call join (or task type) has settled the kind. */
  kindKnown: boolean
  description?: string
  status: ChatBackgroundTaskStatus
  live: boolean
  /** Whether the entry is a promoted, client-visible background task. */
  visible: boolean
  startedAtMs: number
  endedAtMs?: number
  /** The one-line outcome the agent received (notification only). */
  summary?: string
  /** Recorded output file; server-side only, never rides the wire. */
  outputFile?: string
}

export interface ChatBackgroundTasksState {
  /** In start order; promoted entries only become visible on projection. */
  tasks: BackgroundTaskEntry[]
  /**
   * toolCallId → kind, remembered from Bash/Monitor tool calls (the
   * tool_use block streams before task_started). Entries drop their slot
   * when they settle, so the map holds only in-flight and unsettled calls.
   */
  toolKinds: Record<string, ChatBackgroundTaskKind>
}

export function initialChatBackgroundTasksState(): ChatBackgroundTasksState {
  return { tasks: [], toolKinds: {} }
}

export type ChatBackgroundTasksInput =
  | {
      type: 'task_started'
      taskId: string
      toolUseId?: string
      description?: string
      taskType?: string
      background?: boolean
      ambient?: boolean
    }
  | {
      type: 'task_updated'
      taskId: string
      status?: string
      backgrounded?: boolean
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: string
      summary?: string
      outputFile?: string
    }
  /** The CLI's current background set: membership toggles `live`, absence ends it. */
  | { type: 'level_set'; taskIds: string[] }
  /** A Bash/Monitor tool call, for the kind join (the tool_use block streams first). */
  | { type: 'tool_call'; toolCallId: string; tool: string }
  /** The agent process ended: unresolved visible entries settle as stopped. */
  | { type: 'process_end'; nowMs?: number }

const settled = (status: string): ChatBackgroundTaskStatus | null =>
  status === 'completed' || status === 'failed' || status === 'stopped' ? status : null

/**
 * The driver feeds both rosters from one frame parse (`taskFrameToInput` in
 * chatWorkers — ambient and housekeeping tasks are already dropped there).
 * This maps that shared input onto this roster's; worker-only edges
 * (progress, spawn bookkeeping) have no background-task meaning.
 */
export function backgroundInputFromWorkersInput(
  input: import('./chatWorkers').ChatWorkersInput
): ChatBackgroundTasksInput | null {
  switch (input.type) {
    case 'task_started':
      return {
        type: 'task_started',
        taskId: input.taskId,
        ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
        ...(input.background === true ? { background: true } : {}),
      }
    case 'task_updated':
      return {
        type: 'task_updated',
        taskId: input.taskId,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.backgrounded === true ? { backgrounded: true } : {}),
      }
    case 'task_notification':
      return {
        type: 'task_notification',
        taskId: input.taskId,
        ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
        status: input.status,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
      }
    case 'background_tasks':
      return { type: 'level_set', taskIds: input.taskIds }
    default:
      return null
  }
}

export function reduceBackgroundTasks(
  state: ChatBackgroundTasksState,
  input: ChatBackgroundTasksInput,
  nowMs = Date.now()
): ChatBackgroundTasksState {
  switch (input.type) {
    case 'tool_call': {
      // The join answers the one thing task_type cannot: shell vs Monitor
      // (a Monitor's task_started is local_bash too — verified in the 1.1
      // fixtures). It is remembered for the task_started that follows, and
      // still patches an entry that beat it here.
      if (input.tool !== 'Bash' && input.tool !== 'Monitor') return state
      const kind: ChatBackgroundTaskKind = input.tool === 'Monitor' ? 'monitor' : 'shell'
      let changed = false
      const tasks = state.tasks.map((entry) => {
        if (entry.toolCallId !== input.toolCallId || (entry.kindKnown && entry.kind === kind)) return entry
        changed = true
        return { ...entry, kind, kindKnown: true }
      })
      const alreadyKnown = state.toolKinds[input.toolCallId] === kind
      if (!changed && alreadyKnown) return state
      return {
        tasks: changed ? tasks : state.tasks,
        toolKinds: alreadyKnown ? state.toolKinds : { ...state.toolKinds, [input.toolCallId]: kind },
      }
    }
    case 'task_started': {
      if (NON_TASK_TYPES.has(input.taskType ?? '')) return state
      if (input.ambient === true) return state
      if (state.tasks.some((entry) => entry.taskId === input.taskId)) return state
      const joined = input.toolUseId !== undefined ? state.toolKinds[input.toolUseId] : undefined
      const kind = joined ?? (MONITOR_TASK_TYPES.has(input.taskType ?? '') ? 'monitor' : 'shell')
      const entry: BackgroundTaskEntry = {
        taskId: input.taskId,
        ...(input.toolUseId ? { toolCallId: input.toolUseId } : {}),
        kind,
        kindKnown: joined !== undefined || MONITOR_TASK_TYPES.has(input.taskType ?? ''),
        ...(input.description ? { description: input.description } : {}),
        status: 'running',
        live: input.background === true,
        visible: input.background === true,
        startedAtMs: nowMs,
      }
      return { ...state, tasks: [...state.tasks, entry] }
    }
    case 'task_updated': {
      const index = state.tasks.findIndex((entry) => entry.taskId === input.taskId)
      if (index === -1) return state
      const current = state.tasks[index]!
      const patchStatus = input.status ? settled(input.status) ?? (input.status === 'killed' ? 'stopped' : null) : null
      // A foreground completion is a discard, not an outcome (nothing was
      // ever shown); a promoted entry keeps its provisional patch status
      // until the notification lands — killed reads as stopped.
      if (patchStatus !== null && input.backgrounded !== true && !current.visible) {
        return { ...state, tasks: state.tasks.filter((entry) => entry !== current) }
      }
      if (input.backgrounded !== true && patchStatus === null) return state
      const updated: BackgroundTaskEntry = {
        ...current,
        ...(input.backgrounded === true ? { visible: true, live: true } : {}),
        ...(patchStatus !== null && current.status === 'running' ? { status: patchStatus } : {}),
        ...(patchStatus !== null && current.endedAtMs === undefined ? { endedAtMs: nowMs } : {}),
      }
      if (updated === current) return state
      const tasks = [...state.tasks]
      tasks[index] = updated
      return { ...state, tasks }
    }
    case 'task_notification': {
      const status = settled(input.status)
      if (!status) return state
      const index = state.tasks.findIndex((entry) => entry.taskId === input.taskId)
      if (index === -1) return state
      const current = state.tasks[index]!
      const toolKinds = { ...state.toolKinds }
      if (current.toolCallId !== undefined) delete toolKinds[current.toolCallId]
      if (!current.visible) {
        // Settled while still foreground: never shown, never tracked.
        return { ...state, tasks: state.tasks.filter((entry) => entry !== current), toolKinds }
      }
      const tasks = [...state.tasks]
      tasks[index] = {
        ...current,
        status,
        live: false,
        endedAtMs: current.endedAtMs ?? nowMs,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.outputFile ? { outputFile: input.outputFile } : {}),
        ...(input.toolUseId && !current.toolCallId ? { toolCallId: input.toolUseId } : {}),
      }
      return { ...state, tasks, toolKinds }
    }
    case 'level_set': {
      const set = new Set(input.taskIds)
      let changed = false
      const tasks: BackgroundTaskEntry[] = []
      for (const entry of state.tasks) {
        if (!entry.visible) {
          // An unseen background id in the set promotes an entry the
          // task_started edge missed (a reconnect's running set).
          if (set.has(entry.taskId)) {
            changed = true
            tasks.push({ ...entry, visible: true, live: true })
          } else {
            tasks.push(entry)
          }
          continue
        }
        if (set.has(entry.taskId)) {
          tasks.push(entry.live ? entry : { ...entry, live: true })
          if (!entry.live) changed = true
        } else {
          if (entry.live) changed = true
          tasks.push(entry.live ? { ...entry, live: false } : entry)
        }
      }
      return changed ? { ...state, tasks } : state
    }
    case 'process_end': {
      const at = input.nowMs ?? nowMs
      // Candidates die unseen and are dropped; visible unresolved entries
      // settle as stopped (their process is gone). The join map dies with
      // the process: nothing re-streams the old tool calls.
      const kept = state.tasks.filter((entry) => entry.visible)
      if (kept.length === state.tasks.length && !kept.some((entry) => entry.status === 'running') && Object.keys(state.toolKinds).length === 0) return state
      return {
        tasks: kept.map((entry) =>
          entry.status === 'running'
            ? { ...entry, status: 'stopped' as const, live: false, endedAtMs: entry.endedAtMs ?? at }
            : entry
        ),
        toolKinds: {},
      }
    }
  }
}

/**
 * The roster projection for clients: promoted entries in start order with
 * `elapsedMs` computed at publish time (frozen once settled), so live rows
 * tick on the client's clock (design D2). The output-file path stays behind.
 */
export function projectBackgroundTasks(
  state: ChatBackgroundTasksState,
  now = Date.now()
): ChatBackgroundTask[] {
  return state.tasks
    .filter((entry) => entry.visible)
    .map((entry) => ({
      taskId: entry.taskId,
      ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
      kind: entry.kind,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      status: entry.status,
      live: entry.live,
      startedAtMs: entry.startedAtMs,
      ...(entry.endedAtMs !== undefined ? { endedAtMs: entry.endedAtMs } : {}),
      elapsedMs: Math.max(0, (entry.endedAtMs ?? now) - entry.startedAtMs),
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    }))
}

/**
 * The server-side record: identity, outcome, and timing plus the recorded
 * output-file path (design D3), which stays behind the WS boundary — only
 * the sidecar (D6) and the output-tail reader ever see it.
 */
export interface BackgroundTaskRecord {
  taskId: string
  toolCallId?: string
  kind: ChatBackgroundTaskKind
  description?: string
  status: ChatBackgroundTaskStatus
  summary?: string
  outputFile?: string
  startedAtMs: number
  endedAtMs?: number
}

/** Records for the sidecar (design D6): identity and outcome, never live state. */
export function projectBackgroundTaskRecords(state: ChatBackgroundTasksState): BackgroundTaskRecord[] {
  return state.tasks
    .filter((entry) => entry.visible)
    .map((entry) => ({
      taskId: entry.taskId,
      ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
      kind: entry.kind,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      status: entry.status,
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      ...(entry.outputFile !== undefined ? { outputFile: entry.outputFile } : {}),
      startedAtMs: entry.startedAtMs,
      ...(entry.endedAtMs !== undefined ? { endedAtMs: entry.endedAtMs } : {}),
    }))
}

/**
 * Seed a fresh state from persisted rows (design D6): recovered entries are
 * never live, and the sidecar's recovery pass has already rewritten rows
 * still marked running as stopped.
 */
export function recoveredBackgroundTasksState(tasks: ChatBackgroundTask[]): ChatBackgroundTasksState {
  return {
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
      kind: task.kind,
      kindKnown: true,
      ...(task.description !== undefined ? { description: task.description } : {}),
      status: task.status,
      live: false,
      visible: true,
      startedAtMs: task.startedAtMs,
      ...(task.endedAtMs !== undefined ? { endedAtMs: task.endedAtMs } : {}),
      ...(task.summary !== undefined ? { summary: task.summary } : {}),
    })),
    toolKinds: {},
  }
}
