// The SDK's streaming input (task 2.2): an async iterable of user messages
// the driver pushes into. end() closes it, so the SDK closes the CLI's stdin;
// that is the graceful half of stop. Pushing after end is refused, never
// buffered for a process that will not read it.

export class PromptQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private wake: (() => void) | null = null
  private closed = false

  get ended(): boolean {
    return this.closed
  }

  push(item: T): boolean {
    if (this.closed) return false
    this.items.push(item)
    this.signal()
    return true
  }

  /** Drop the items the SDK has not read yet, returning them (interrupt). */
  clearPending(): T[] {
    return this.items.splice(0)
  }

  end(): void {
    this.closed = true
    this.signal()
  }

  private signal(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}
