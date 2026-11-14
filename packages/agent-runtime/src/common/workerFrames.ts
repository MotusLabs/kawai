// Moved from Kawai src/server/chat/chatWorkers.ts (agent-runtime task 4.1); behavior unchanged.
// Split out of workers.ts (size only): the structural task_* frame slice and
// its mapping to a roster input. The reducer and projection stay in
// workers.ts, which re-exports these names.
import type { ChatWorkersInput } from './workers.js'

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
  /** SDKTaskNotificationMessage.status ('completed' | 'failed' | 'stopped'). */
  status?: string | null
  summary?: string
  /** SDKTaskNotificationMessage.output_file — the task's recorded output. */
  output_file?: string
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
        ...(typeof frame.output_file === 'string' && frame.output_file
          ? { outputFile: frame.output_file }
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
