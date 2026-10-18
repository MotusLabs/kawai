// Async message queue feeding a streaming-input SDK query(), modeled on the
// MessageQueue pattern from Anthropic's agent-sdk demos: query() consumes the
// queue as its prompt, user turns are pushed into it as they are submitted.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * A pull-based queue of user turns. The SDK's query() iterates it; `push`
 * resolves a pending pull or buffers for the next one. `clearPending` drops
 * everything not yet consumed (stop discards queued unsent messages) and
 * `end` terminates the iterator (kill/shutdown). Generic over its item type
 * (design D1); the Claude driver keeps the SDK message default.
 */
export class TurnQueue<T = SDKUserMessage> implements AsyncIterable<T> {
  private queued: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(message: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: message, done: false })
    } else {
      this.queued.push(message)
    }
  }

  /** Drop messages the SDK has not consumed yet, returning them. */
  clearPending(): T[] {
    return this.queued.splice(0)
  }

  /** End iteration; pending pulls resolve done and later pushes are no-ops. */
  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const pull = (): Promise<IteratorResult<T>> =>
      new Promise((resolve) => {
        const next = this.queued.shift()
        if (next !== undefined || this.ended) {
          resolve(
            next !== undefined
              ? { value: next, done: false }
              : { value: undefined, done: true }
          )
        } else {
          this.waiters.push(resolve)
        }
      })

    return { next: pull }
  }
}
