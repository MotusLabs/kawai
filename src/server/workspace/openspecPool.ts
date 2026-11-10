// openspecPool.ts - A FIFO concurrency pool for `openspec list` runs
// (bounded-openspec-discovery D3). One server-wide instance of size 3 runs
// every production discovery, across repositories and passes. A released
// slot is handed straight to the next waiter, so a newcomer can never slip in
// between and push the count past the size. The pooled runner leaves the
// timeout inside the runner, whose timer starts after the spawn, so time in
// the queue never counts toward it.

import { runOpenspecList, type OpenspecCommandRunner } from './openspecDiscovery'

export const OPENSPEC_POOL_SIZE = 3

export class ConcurrencyPool {
  readonly size: number
  private active = 0
  private readonly waiters: Array<() => void> = []
  private peak = 0
  private started = 0

  constructor(size: number) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error(`pool size must be a positive integer, got ${size}`)
    this.size = size
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    this.started += 1
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  /** Running tasks now. */
  activeCount(): number {
    return this.active
  }

  /** Tasks started since construction. */
  startedCount(): number {
    return this.started
  }

  /** The highest concurrency since the last call, then reset to the current count. */
  takePeak(): number {
    const peak = this.peak
    this.peak = this.active
    return peak
  }

  private acquire(): Promise<void> {
    if (this.active < this.size) {
      this.active += 1
      this.peak = Math.max(this.peak, this.active)
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    // Hand the slot over: `active` stays the same for the next task.
    if (next) next()
    else this.active -= 1
  }
}

/** Route a runner through a pool; the runner's own timeout starts at spawn. */
export function createPooledOpenspecRunner(
  pool: ConcurrencyPool,
  runner: OpenspecCommandRunner = runOpenspecList
): OpenspecCommandRunner {
  return (options) => pool.run(() => runner(options))
}

/** The one server-wide pool every production `openspec list` run passes through. */
export const openspecListPool = new ConcurrencyPool(OPENSPEC_POOL_SIZE)
export const pooledOpenspecRunner: OpenspecCommandRunner = createPooledOpenspecRunner(openspecListPool)
