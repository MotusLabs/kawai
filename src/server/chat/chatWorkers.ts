// Pure frame-to-roster mapping for chat-session workers (design D3): the
// task_* edge stream and the background level set reduce into a per-session
// worker roster, and the roster projects to the ephemeral ChatWorker[] sent
// to clients. Side-effect free and SDK-free (frames are matched structurally,
// slices mirror sdk.d.ts), so tests pin shapes copied from real wire captures
// and the direct-CLI transport of replace-claude-sdk-with-cli can reuse the
// mapping. View rules (the live strip, row rendering) stay client-side; this
// module only reports what the fleet is doing.
//
// Two invariants hold the whole design (D3):
// - The roster is built from the edge stream only; the background level set
//   is a liveness signal, never a roster source and never an outcome source.
// - `live` (is it running right now) and `status` (its settled outcome) are
//   separate fields, which is what makes the reducer immune to frame
//   ordering: a set that drops a task before its notification leaves the row
//   running-but-not-live for one frame, not stopped.
import type { ChatWorker, ChatWorkerStatus } from '../../shared/chat'

/** One roster row; `startedAt` anchors the projected elapsed time. */
export interface ChatWorkerEntry {
  /** The spawning Agent tool call's id. */
  workerId: string
  /** SDK task handle; joins the frames that carry no tool_use_id. */
  taskId?: string
  agentType?: string
  description?: string
  /** 1 for a top-level spawn; omit when unknown. */
  depth?: number
  status: ChatWorkerStatus
  live: boolean
  /**
   * The task registered in the background. Only background workers are
   * governed by the level set; a foreground worker is never in it, so the
   * set must not clear one that is simply absent (design D3).
   */
  background: boolean
  /** Most recent tool the worker ran. */
  lastTool?: string
  /** Settled workers only. */
  summary?: string
  /** Wall-clock ms at spawn; `elapsedMs` is projected from it. */
  startedAt: number
}

export interface ChatWorkersState {
  /** Spawn order; the roster projection keeps it. */
  workers: ChatWorkerEntry[]
}

export function initialChatWorkersState(): ChatWorkersState {
  return { workers: [] }
}

/** Normalized roster inputs; the driver maps raw frames onto these. */
export type ChatWorkersInput =
  /** A tool_call for Agent/Task: the row anchor (design D1). */
  | { type: 'spawn'; toolCallId: string }
  | {
      type: 'task_started'
      taskId: string
      toolUseId?: string
      agentType?: string
      description?: string
      depth?: number
      /** SDK task_type ('local_agent', ...); only local_agent rows spawn. */
      taskType?: string
      background?: boolean
    }
  | {
      type: 'task_progress'
      taskId: string
      toolUseId?: string
      description?: string
      lastTool?: string
    }
  | {
      type: 'task_updated'
      taskId: string
      status?: string
      description?: string
      backgrounded?: boolean
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      summary?: string
    }
  | {
      /** The background level set: live membership, nothing else (D3). */
      type: 'background_tasks'
      taskIds: string[]
    }
  /** Driver death, interrupt, archive, kill: settle everything unresolved. */
  | { type: 'process_end' }

/**
 * Structural slice of the `system` frames the roster consumes; keeps this
 * module SDK-free. Field names follow sdk.d.ts verbatim so the driver can
 * pass its frames straight through.
 */
export interface ChatTaskFrameSlice {
  subtype?: string
  task_id?: string
  tool_use_id?: string
  description?: string
  subagent_type?: string
  spawn_depth?: number
  /** SDKTaskStartedMessage.task_type: 'local_agent', 'local_bash', ... */
  task_type?: string
  is_backgrounded?: boolean
  last_tool_name?: string
  /** SDKTaskNotificationMessage.status. */
  status?: string
  summary?: string
  /** SDKTaskUpdatedMessage.patch. */
  patch?: { status?: string; description?: string; is_backgrounded?: boolean }
  /** SDKBackgroundTasksChangedMessage.tasks. */
  tasks?: Array<{ task_id?: string; ambient?: boolean }>
  /** Housekeeping markers: such tasks are not user-facing activity. */
  ambient?: boolean
  skip_transcript?: boolean
}

/**
 * A task frame → input, or null when it carries no roster signal: non-task
 * subtypes, housekeeping tasks (`ambient`, `skip_transcript`), and payloads
 * without a usable task id. Ambient entries are filtered out of the level
 * set too — the SDK's own guidance is to exclude them from activity.
 */
export function taskFrameToInput(
  frame: ChatTaskFrameSlice
): ChatWorkersInput | null {
  if (frame.ambient === true || frame.skip_transcript === true) return null
  switch (frame.subtype) {
    case 'task_started': {
      if (typeof frame.task_id !== 'string' || !frame.task_id) return null
      return {
        type: 'task_started',
        taskId: frame.task_id,
        ...(typeof frame.tool_use_id === 'string' && frame.tool_use_id
          ? { toolUseId: frame.tool_use_id }
          : {}),
        ...(typeof frame.subagent_type === 'string' && frame.subagent_type
          ? { agentType: frame.subagent_type }
          : {}),
        ...(typeof frame.description === 'string' && frame.description
          ? { description: frame.description }
          : {}),
        ...(typeof frame.spawn_depth === 'number'
          ? { depth: frame.spawn_depth }
          : {}),
        ...(typeof frame.task_type === 'string' && frame.task_type
          ? { taskType: frame.task_type }
          : {}),
        ...(frame.is_backgrounded === true ? { background: true } : {}),
      }
    }
    case 'task_progress': {
      if (typeof frame.task_id !== 'string' || !frame.task_id) return null
      return {
        type: 'task_progress',
        taskId: frame.task_id,
        ...(typeof frame.tool_use_id === 'string' && frame.tool_use_id
          ? { toolUseId: frame.tool_use_id }
          : {}),
        ...(typeof frame.description === 'string' && frame.description
          ? { description: frame.description }
          : {}),
        ...(typeof frame.last_tool_name === 'string' && frame.last_tool_name
          ? { lastTool: frame.last_tool_name }
          : {}),
      }
    }
    case 'task_updated': {
      if (typeof frame.task_id !== 'string' || !frame.task_id) return null
      const patch = frame.patch
      return {
        type: 'task_updated',
        taskId: frame.task_id,
        ...(typeof patch?.status === 'string' ? { status: patch.status } : {}),
        ...(typeof patch?.description === 'string' && patch.description
          ? { description: patch.description }
          : {}),
        ...(patch?.is_backgrounded === true ? { backgrounded: true } : {}),
      }
    }
    case 'task_notification': {
      if (typeof frame.task_id !== 'string' || !frame.task_id) return null
      if (
        frame.status !== 'completed' &&
        frame.status !== 'failed' &&
        frame.status !== 'stopped'
      ) {
        return null
      }
      return {
        type: 'task_notification',
        taskId: frame.task_id,
        ...(typeof frame.tool_use_id === 'string' && frame.tool_use_id
          ? { toolUseId: frame.tool_use_id }
          : {}),
        status: frame.status,
        ...(typeof frame.summary === 'string' && frame.summary
          ? { summary: frame.summary }
          : {}),
      }
    }
    case 'background_tasks_changed': {
      const taskIds = (frame.tasks ?? [])
        .filter(
          (task) =>
            typeof task.task_id === 'string' &&
            task.task_id &&
            task.ambient !== true
        )
        .map((task) => task.task_id as string)
      return { type: 'background_tasks', taskIds }
    }
    default:
      return null
  }
}

/**
 * The roster projection for clients: entries in spawn order with `elapsedMs`
 * computed at publish time, so live rows tick on the client's clock (D2).
 */
export function projectWorkers(
  state: ChatWorkersState,
  now = Date.now()
): ChatWorker[] {
  return state.workers.map((entry) => ({
    workerId: entry.workerId,
    ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
    ...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
    ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
    status: entry.status,
    live: entry.live,
    ...(entry.lastTool !== undefined ? { lastTool: entry.lastTool } : {}),
    elapsedMs: Math.max(0, now - entry.startedAt),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
  }))
}

/**
 * Whether any worker is live — the `working`-status half of design D7. A
 * worker in the completion gap (running, not live) does not count.
 */
export function anyWorkerLive(state: ChatWorkersState): boolean {
  return state.workers.some((worker) => worker.live)
}

/** The row minus its time anchor — the identity of a roster version. */
function workerBody(entry: ChatWorkerEntry): Omit<ChatWorkerEntry, 'startedAt'> {
  const { startedAt: _startedAt, ...body } = entry
  return body
}

function sameRoster(a: ChatWorkersState, b: ChatWorkersState): boolean {
  if (a.workers.length !== b.workers.length) return false
  return a.workers.every(
    (entry, index) =>
      JSON.stringify(workerBody(entry)) ===
      JSON.stringify(workerBody(b.workers[index]!))
  )
}

/** A task that belongs to an agent the session spawned (design D3). */
function isAgentTask(input: {
  agentType?: string
  taskType?: string
}): boolean {
  return input.agentType !== undefined || input.taskType === 'local_agent'
}

function findEntry(
  state: ChatWorkersState,
  keys: { workerId?: string; taskId?: string }
): ChatWorkerEntry | undefined {
  return state.workers.find(
    (entry) =>
      (keys.workerId !== undefined && entry.workerId === keys.workerId) ||
      (keys.taskId !== undefined && entry.taskId === keys.taskId)
  )
}

/** Join a task frame's row by its tool call id first, then its task id. */
function findTaskEntry(
  state: ChatWorkersState,
  input: { toolUseId?: string; taskId?: string }
): ChatWorkerEntry | undefined {
  return findEntry(state, {
    workerId: input.toolUseId,
    taskId: input.taskId,
  })
}

function withEntry(
  state: ChatWorkersState,
  entry: ChatWorkerEntry
): ChatWorkersState {
  const index = state.workers.findIndex(
    (existing) => existing.workerId === entry.workerId
  )
  const workers = [...state.workers]
  if (index === -1) workers.push(entry)
  else workers[index] = entry
  const next = { workers }
  return sameRoster(state, next) ? state : next
}

/**
 * One transition of the design D3 table. Unknown values leave the roster
 * untouched, so a frame shape change degrades a row to coarser state (no
 * last-tool, no summary), never to an error.
 */
export function reduceWorkers(
  state: ChatWorkersState,
  input: ChatWorkersInput,
  now = Date.now()
): ChatWorkersState {
  switch (input.type) {
    case 'spawn': {
      if (findEntry(state, { workerId: input.toolCallId })) return state
      return {
        workers: [
          ...state.workers,
          {
            workerId: input.toolCallId,
            status: 'running',
            live: true,
            background: false,
            startedAt: now,
          },
        ],
      }
    }
    case 'task_started': {
      const existing = findTaskEntry(state, input)
      // A task that is not a spawned agent (backgrounded Bash, MCP, workflow)
      // and has no row to fill is not a worker; without a tool_use_id it
      // cannot be joined to one anyway (design D3).
      if (!existing && !isAgentTask(input)) return state
      if (!existing && input.toolUseId === undefined) return state
      const base: ChatWorkerEntry = existing ?? {
        workerId: input.toolUseId!,
        status: 'running',
        live: true,
        background: false,
        startedAt: now,
      }
      return withEntry(
        state,
        {
          ...base,
          taskId: input.taskId,
          ...(input.agentType !== undefined || base.agentType !== undefined
            ? {
                agentType: input.agentType ?? base.agentType,
              }
            : {}),
          ...(input.description ?? base.description
            ? { description: input.description ?? base.description }
            : {}),
          ...(input.depth ?? base.depth
            ? { depth: input.depth ?? base.depth }
            : {}),
          status: 'running',
          live: true,
          background: base.background || input.background === true,
        },
      )
    }
    case 'task_progress': {
      const existing = findTaskEntry(state, input)
      if (!existing) return state
      return withEntry(
        state,
        {
          ...existing,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.lastTool !== undefined
            ? { lastTool: input.lastTool }
            : {}),
        },
      )
    }
    case 'task_updated': {
      const existing = findEntry(state, { taskId: input.taskId })
      if (!existing) return state
      const settled = settleStatus(input.status)
      return withEntry(
        state,
        {
          ...existing,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.backgrounded === true ? { background: true } : {}),
          ...(settled !== undefined
            ? { status: settled, live: false }
            : {}),
        },
      )
    }
    case 'task_notification': {
      // Always writes its status and summary, clearing live — including over
      // a provisional outcome an earlier task_updated wrote (design D3).
      const existing = findTaskEntry(state, input)
      if (!existing) return state
      return withEntry(
        state,
        {
          ...existing,
          status: input.status,
          live: false,
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        },
      )
    }
    case 'background_tasks': {
      // Membership is authoritative for background liveness and writes
      // nothing else: foreground workers are absent from the set by
      // definition, so their live stays edge-driven (design D3).
      const live = new Set(input.taskIds)
      let changed = false
      const workers = state.workers.map((entry) => {
        if (!entry.background || entry.live === live.has(entry.taskId ?? '')) {
          return entry
        }
        changed = true
        return { ...entry, live: live.has(entry.taskId ?? '') }
      })
      return changed ? { workers } : state
    }
    case 'process_end': {
      // Everything still without an outcome settles as stopped; nothing may
      // survive the process reading as live (design D3/D6).
      if (!state.workers.some((w) => w.status === 'running' || w.live)) {
        return state
      }
      return {
        workers: state.workers.map((entry) =>
          entry.status === 'running'
            ? { ...entry, status: 'stopped' as const, live: false }
            : entry.live
              ? { ...entry, live: false }
              : entry
        ),
      }
    }
  }
}

/** A task_updated patch status → settled worker status, if it settles. */
function settleStatus(status: string | undefined): ChatWorkerStatus | undefined {
  if (status === 'completed' || status === 'failed') return status
  if (status === 'killed') return 'stopped'
  // pending / running / paused are not outcomes; the row keeps its state.
  return undefined
}
