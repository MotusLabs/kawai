// A controlled Claude query (design §5 runtime test seams): the session core
// runs unchanged while a test decides every frame, the initialize response
// and the stream's end. It replaces only the SDK's query(); turn binding,
// requests, events and the lifecycle are the production code. No process is
// spawned, so these tests prove frame handling, not native exit (the fake CLI
// tests cover that).
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeQueryFactory } from '../../src/claude/session.js'

export class ControlledQuery {
  readonly prompts: SDKUserMessage[] = []
  readonly interrupts: unknown[] = []
  closed = false
  /** When true, close() leaves the stream open until exit() (holds a stop in `stopping`). */
  holdOnClose = false
  /** UUIDs the next interrupt acknowledgement reports as cancelled. */
  cancelOnInterrupt: string[] = []
  /** The frame being handled right now (set just before it is yielded). */
  yielded: SDKMessage | null = null
  private readonly queue: SDKMessage[] = []
  private wake: (() => void) | null = null
  private ended = false
  private initSettled = false
  private resolveInit!: (value: unknown) => void
  private rejectInit!: (error: unknown) => void
  private readonly init: Promise<unknown>

  constructor(readonly options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    this.init = new Promise((resolve, reject) => {
      this.resolveInit = resolve
      this.rejectInit = reject
    })
    this.init.catch(() => {})
    void (async () => {
      for await (const message of prompt) this.prompts.push(message)
    })()
  }

  get isEnded(): boolean {
    return this.ended
  }

  initializationResult(): Promise<unknown> {
    return this.init
  }

  ready(commands: unknown[] = []): void {
    this.initSettled = true
    this.resolveInit({ commands, agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] })
  }

  push(...frames: SDKMessage[]): void {
    if (this.ended) return
    this.queue.push(...frames)
    this.signal()
  }

  /** The process ended: the stream finishes, and a pending initialize then fails. */
  exit(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
    if (!this.initSettled) {
      this.initSettled = true
      setTimeout(() => this.rejectInit(new Error('the process exited before initialize')), 0)
    }
  }

  close(): void {
    this.closed = true
    if (!this.holdOnClose) this.exit()
  }

  async interrupt(options?: unknown): Promise<{ cancelled: string[] }> {
    this.interrupts.push(options)
    return { cancelled: this.cancelOnInterrupt.splice(0) }
  }

  async stopTask(): Promise<void> {}

  /** Resolves once every pushed frame has been handled. */
  async drain(): Promise<void> {
    for (let i = 0; i < 50 && (this.queue.length > 0 || this.yielded !== null); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  private signal(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      const frame = this.queue.shift()
      if (frame) {
        this.yielded = frame
        yield frame
        this.yielded = null
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}

export function controlledQueries(): { factory: ClaudeQueryFactory; queries: ControlledQuery[]; latest(): ControlledQuery } {
  const queries: ControlledQuery[] = []
  const factory: ClaudeQueryFactory = ({ prompt, options }) => {
    const query = new ControlledQuery(options, prompt)
    queries.push(query)
    return query as unknown as Query
  }
  return { factory, queries, latest: () => queries.at(-1)! }
}

let frameCounter = 0
const id = (prefix: string) => `${prefix}-${++frameCounter}`

export const frames = {
  init(sessionId = 'sess-1', model = 'model-a'): SDKMessage {
    return { type: 'system', subtype: 'init', session_id: sessionId, model, uuid: id('init'), cwd: '/', tools: [] } as unknown as SDKMessage
  },
  text(text: string, model = 'model-a'): SDKMessage {
    return { type: 'assistant', uuid: id('a'), session_id: 'sess-1', parent_tool_use_id: null, message: { id: id('msg'), role: 'assistant', model, content: [{ type: 'text', text }] } } as unknown as SDKMessage
  },
  result(uuids: string[], text = 'done', subtype = 'success', isError = false): SDKMessage {
    return {
      type: 'result', subtype, is_error: isError, ...(subtype === 'success' ? { result: text } : {}), num_turns: 1, total_cost_usd: 0,
      uuid: id('r'), session_id: 'sess-1', user_message_uuids: uuids, ...(uuids.length > 0 ? { user_message_uuid: uuids[0] } : {}),
    } as unknown as SDKMessage
  },
  taskNotification(taskId: string, status = 'completed', summary = 'task done'): SDKMessage {
    return { type: 'system', subtype: 'task_notification', task_id: taskId, status, summary, uuid: id('tn'), session_id: 'sess-1' } as unknown as SDKMessage
  },
}
