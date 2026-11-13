// Ephemeral session signals (design §1 "activity/worker/background reducers"):
// live turn activity, the spawned-worker and background-task rosters, agent
// notifications and the slash-command state. None of these is an AgentEvent;
// they are never sequenced or replayed. Shapes are Kawai's, unchanged.

export type ActivityPhase = 'requesting' | 'thinking' | 'responding' | 'preparing_tool' | 'running_tools' | 'retrying'

export interface Activity {
  phase: ActivityPhase
  /** Milliseconds already spent in this phase when reported. */
  elapsedMs: number
  /** preparing_tool / running_tools: oldest unresolved tool name. */
  tool?: string
  /** running_tools: unresolved tool calls (>= 1). */
  count?: number
  attempt?: number
  maxRetries?: number
  errorStatus?: number
}

export type WorkerStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** An agent spawned by the session's Agent/Task tool call. */
export interface Worker {
  workerId: string
  taskId?: string
  agentType?: string
  description?: string
  depth?: number
  status: WorkerStatus
  live: boolean
  lastTool?: string
  elapsedMs: number
  summary?: string
}

export type BackgroundTaskKind = 'shell' | 'monitor'
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** A background shell or Monitor the agent started. */
export interface BackgroundTask {
  taskId: string
  toolCallId?: string
  kind: BackgroundTaskKind
  description?: string
  status: BackgroundTaskStatus
  live: boolean
  startedAtMs: number
  endedAtMs?: number
  elapsedMs: number
  summary?: string
  /**
   * Claude only: the task's recorded output file as the SDK reported it
   * (a nonempty string), else absent. A host showing tasks to others should
   * keep it private.
   */
  outputFile?: string
}

export interface AgentNotification {
  key: string
  severity: 'info' | 'warning' | 'error'
  priority: 'low' | 'medium' | 'high' | 'immediate'
  text: string
  hint?: string
  receivedAt: string
}

export interface SlashCommand {
  /** Without the leading slash. */
  name: string
  description: string
  argumentHint?: string
  aliases: string[]
  source: 'builtin' | 'project' | 'user'
}

export interface CommandState {
  status: 'loading' | 'ready' | 'unavailable'
  commands: SlashCommand[]
}
