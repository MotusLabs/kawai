// Claude content frames to events and session signals (moved from Kawai's
// ChatSessionDriver in task 4.1). The session decides turn binding (init,
// result) and asks `frameTurnId()` whether content belongs to the active
// turn. Everything else is mapped here:
// - assistant text, deltas, tool calls and results, and command output become
//   events;
// - live activity, the spawned-worker roster, background tasks, notices and
//   the slash-command list are reduced and reported through callbacks.
// Subagent content stays out of the parent transcript (the Agent/Task spawn
// call and its result excepted, which anchor the worker row). Echoes of the
// session's own prompts are suppressed by message UUID, then by text. Task
// notifications that arrive between turns become the next agent-started
// turn's trigger.
import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentNotification } from '../activity.js'
import type { EventBody } from '../eventStream.js'
import type { TurnTrigger, TurnTriggerTask } from '../events.js'
import type { JsonValue } from '../json.js'
import type { AgentCallbacks } from '../options.js'
import { activityBody, contentBlockToInput, initialChatActivityState, projectActivity, reduceActivity, systemFrameToInput, type ChatActivityInput } from '../common/activity.js'
import { backgroundInputFromWorkersInput, initialChatBackgroundTasksState, projectBackgroundTasks, reduceBackgroundTasks, type ChatBackgroundTasksInput } from '../common/backgroundTasks.js'
import { anyWorkerLive, initialChatWorkersState, projectWorkers, reduceWorkers, taskFrameToInput, type ChatWorkersInput } from '../common/workers.js'
import { ChatCommandTracker, type RawChatCommand } from './commands.js'
import { toolResultText } from './contentBlocks.js'

type SystemMessage = Extract<SDKMessage, { type: 'system' }>

export interface FrameHost {
  emit(body: EventBody): void
  /** The turn content belongs to, or null (no turn, or an interrupted turn's result is owed). */
  frameTurnId(): string | null
  /** The active turn, whether or not content currently belongs to it. */
  activeTurnId(): string | null
  callbacks: AgentCallbacks
  /** Run a host callback; a throw is retained and changes nothing here. */
  notify(name: string, callback: () => void): void
  /** A compaction boundary was observed; true the first time its id is seen. */
  compacted(boundaryId: string, preTokens: number | null, postTokens: unknown): boolean
}

/** The tools that spawn a worker: both names, current and old. */
function isAgentSpawnTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

/** Assistant/user frames with a parent tool call come from a subagent. */
function isSubagentFrame(frame: object): boolean {
  return (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id != null
}

function severity(color: unknown): AgentNotification['severity'] {
  return color === 'warning' || color === 'error' ? color : 'info'
}

function priority(value: unknown): AgentNotification['priority'] {
  return value === 'immediate' || value === 'high' || value === 'medium' || value === 'low' ? value : 'low'
}

export class ClaudeFrames {
  private activity = initialChatActivityState()
  private workers = initialChatWorkersState()
  private background = initialChatBackgroundTasksState()
  readonly commands: ChatCommandTracker
  private readonly agentToolCallIds = new Set<string>()
  private streamingMessageId: string | null = null
  private pendingTasks: TurnTriggerTask[] = []
  /** Outstanding echo tokens: own prompt UUIDs (with their text), then texts. */
  private readonly sentUuids = new Map<string, string>()
  private readonly sentTexts = new Map<string, number>()

  constructor(private readonly host: FrameHost) {
    this.commands = new ChatCommandTracker((state) => {
      const onCommandState = host.callbacks.onCommandState
      if (onCommandState) host.notify('onCommandState', () => onCommandState(state))
    })
  }

  /** A live worker holds the session busy (Kawai status). */
  get workersLive(): boolean {
    return anyWorkerLive(this.workers)
  }

  /** A prompt this session sent; its echo is suppressed. */
  sent(uuid: string, text: string): void {
    this.sentUuids.set(uuid, text)
    this.sentTexts.set(text, (this.sentTexts.get(text) ?? 0) + 1)
  }

  /** The trigger of an agent-started turn: the task notifications held since the last turn, else resumed. */
  takeTrigger(): TurnTrigger {
    const tasks = this.pendingTasks
    this.pendingTasks = []
    return tasks.length > 0 ? { kind: 'task', tasks } : { kind: 'resumed' }
  }

  /** Any turn opened: held notifications belong to it, not to a later one. */
  turnOpened(): void {
    this.pendingTasks = []
    this.feedActivity({ type: 'turn_started' })
  }

  turnEnded(): void {
    this.feedActivity({ type: 'turn_end' })
  }

  requestResolved(): void {
    this.feedActivity({ type: 'request_resolved' })
  }

  /** An interrupt: workers die with the aborted turn; background tasks survive it. */
  interrupted(): void {
    this.feedWorkers({ type: 'process_end' })
  }

  /** The process ended or the session stopped: nothing it ran is live any more. */
  processEnded(): void {
    this.feedWorkers({ type: 'process_end' })
    this.feedBackground({ type: 'process_end' })
    this.feedActivity({ type: 'turn_end' })
    this.commands.markUnavailable()
  }

  assistant(message: SDKAssistantMessage): { text: string; model: string | null } | null {
    const turnId = this.host.frameTurnId()
    if (!turnId) return null
    const messageId = message.message.id ?? message.uuid
    const subagent = isSubagentFrame(message)
    let text = ''
    for (const block of message.message.content) {
      if (block.type === 'text') {
        if (subagent) continue
        text += block.text
        this.host.emit({ type: 'assistant_text', turnId, messageId, text: block.text })
      } else if (block.type === 'tool_use') {
        if (subagent && !isAgentSpawnTool(block.name)) continue
        this.host.emit({ type: 'tool_call', turnId, toolCallId: block.id, tool: block.name, input: (block.input ?? null) as JsonValue })
        if (isAgentSpawnTool(block.name)) {
          this.agentToolCallIds.add(block.id)
          this.feedWorkers({ type: 'spawn', toolCallId: block.id })
        }
        if (block.name === 'Bash' || block.name === 'Monitor') this.feedBackground({ type: 'tool_call', toolCallId: block.id, tool: block.name })
        if (!subagent) this.feedActivity({ type: 'tool_call', toolCallId: block.id, tool: block.name })
      }
    }
    return subagent ? null : { text, model: message.message.model ?? null }
  }

  partial(message: SDKPartialAssistantMessage): void {
    if (isSubagentFrame(message)) return
    const turnId = this.host.frameTurnId()
    if (!turnId) return
    const event = message.event
    if (event.type === 'message_start') this.streamingMessageId = event.message.id
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.host.emit({ type: 'assistant_delta', turnId, messageId: this.streamingMessageId ?? message.uuid, delta: event.delta.text })
    }
    if (event.type === 'content_block_start') {
      const input = contentBlockToInput(event.content_block)
      if (input) this.feedActivity(input)
    }
  }

  user(message: SDKUserMessage): void {
    const turnId = this.host.frameTurnId()
    if (!turnId) return
    const content = message.message.content
    const subagent = isSubagentFrame(message)
    const echoed = !subagent && this.takeEcho(message)
    if (typeof content === 'string') {
      if (!echoed && !this.consumeText(content)) this.userText(turnId, content, message)
      return
    }
    for (const block of content) {
      if (block.type === 'tool_result') {
        if (subagent && !this.agentToolCallIds.has(block.tool_use_id)) continue
        const output = toolResultText(block.content)
        this.host.emit({ type: 'tool_result', turnId, toolCallId: block.tool_use_id, output, isError: block.is_error === true })
        if (block.is_error && this.agentToolCallIds.has(block.tool_use_id)) this.feedWorkers({ type: 'spawn_rejected', toolCallId: block.tool_use_id, summary: output })
        if (!subagent) this.feedActivity({ type: 'tool_result', toolCallId: block.tool_use_id })
      } else if (block.type === 'text' && !subagent && !echoed && !this.consumeText(block.text)) {
        this.userText(turnId, block.text, message)
      }
    }
  }

  /** System frames other than init: commands, output, notices, compaction, tasks, activity. */
  system(message: SystemMessage): void {
    switch (message.subtype) {
      case 'commands_changed':
        this.commands.applyCommands(message.commands as RawChatCommand[])
        return
      case 'local_command_output': {
        const turnId = this.host.frameTurnId()
        if (turnId) this.host.emit({ type: 'command_output', turnId, text: message.content })
        return
      }
      case 'notification':
        this.notification(message)
        return
      case 'compact_boundary': {
        const pre = message.compact_metadata?.pre_tokens
        // A repeated boundary id is announced once (R03).
        if (this.host.compacted(message.uuid, typeof pre === 'number' && Number.isFinite(pre) && pre > 0 ? pre : null, message.compact_metadata?.post_tokens)) {
          this.host.emit({ type: 'notice', text: 'Context compacted', kind: 'compacted' })
        }
        return
      }
    }
    if (message.subtype === 'task_notification' && !this.host.activeTurnId() && typeof message.task_id === 'string' && message.task_id) {
      this.pendingTasks.push({
        taskId: message.task_id,
        ...(typeof message.tool_use_id === 'string' && message.tool_use_id ? { toolCallId: message.tool_use_id } : {}),
        status: typeof message.status === 'string' ? message.status : 'unknown',
        ...(typeof message.summary === 'string' && message.summary ? { summary: message.summary } : {}),
      })
    }
    const roster = taskFrameToInput(message)
    if (roster) {
      this.feedWorkers(roster)
      const background = backgroundInputFromWorkersInput(roster)
      if (background) this.feedBackground(background)
      return
    }
    if (isSubagentFrame(message)) return
    const input = systemFrameToInput(message)
    if (input) this.feedActivity(input)
  }

  private notification(message: Extract<SystemMessage, { subtype: 'notification' }>): void {
    const onNotification = this.host.callbacks.onNotification
    if (!onNotification || typeof message.key !== 'string' || !message.key || typeof message.text !== 'string' || !message.text) return
    const notice: AgentNotification = { key: message.key, severity: severity(message.color), priority: priority(message.priority), text: message.text, receivedAt: new Date().toISOString() }
    this.host.notify('onNotification', () => onNotification(notice))
  }

  /** A user frame that is not this session's own prompt (e.g. CLI-injected text). */
  private userText(turnId: string, text: string, message: SDKUserMessage): void {
    this.host.emit({ type: 'user_message', turnId, text, messageUuid: typeof message.uuid === 'string' && message.uuid ? message.uuid : crypto.randomUUID() })
  }

  private takeEcho(message: SDKUserMessage): boolean {
    const uuid = typeof message.uuid === 'string' ? message.uuid : ''
    const text = uuid ? this.sentUuids.get(uuid) : undefined
    if (text === undefined) return false
    this.sentUuids.delete(uuid)
    this.consumeText(text)
    return true
  }

  private consumeText(text: string): boolean {
    const outstanding = this.sentTexts.get(text) ?? 0
    if (outstanding <= 0) return false
    if (outstanding === 1) this.sentTexts.delete(text)
    else this.sentTexts.set(text, outstanding - 1)
    return true
  }

  private feedActivity(input: ChatActivityInput): void {
    const previous = this.activity
    this.activity = reduceActivity(previous, input)
    const changed = JSON.stringify(activityBody(previous)) !== JSON.stringify(activityBody(this.activity)) || previous.phaseStartedAt !== this.activity.phaseStartedAt
    const onActivity = this.host.callbacks.onActivity
    if (changed && onActivity) {
      const projected = projectActivity(this.activity)
      this.host.notify('onActivity', () => onActivity(projected))
    }
  }

  private feedWorkers(input: ChatWorkersInput): void {
    const next = reduceWorkers(this.workers, input)
    if (next === this.workers) return
    this.workers = next
    const onWorkers = this.host.callbacks.onWorkers
    if (onWorkers) {
      const projected = projectWorkers(next)
      this.host.notify('onWorkers', () => onWorkers(projected))
    }
  }

  private feedBackground(input: ChatBackgroundTasksInput): void {
    const next = reduceBackgroundTasks(this.background, input)
    if (next === this.background) return
    this.background = next
    const onBackgroundTasks = this.host.callbacks.onBackgroundTasks
    if (onBackgroundTasks) {
      const projected = projectBackgroundTasks(next)
      this.host.notify('onBackgroundTasks', () => onBackgroundTasks(projected))
    }
  }
}
