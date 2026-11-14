// The old-frame scope (task 5.4, INV-A2; Lead disposition a546aea5). A
// terminal frame of turn A is decided first: A is settled, removed and its
// lifecycle result taken. Then its publications and its own observations run
// inside this scope: A's events, handle and onTurnResult, and the model
// windows, context usage, final limit and wait end that A's frame produced.
// A control reentered from them acts on A's frame only. A is already
// decided, so an interrupt there touches no successor. A turn admitted
// meanwhile holds its admission at once, but its opening events wait until
// the outermost scope ends. Only then is a queued successor promoted. A stop
// keeps its priority throughout: it is driver-wide, not frame-scoped.
export class OldFrameScope {
  private depth = 0
  private deferred: Array<() => void> = []

  /** True while a decided frame's publications or observations run. */
  get active(): boolean {
    return this.depth > 0
  }

  run<T>(body: () => T): T {
    this.depth += 1
    try {
      return body()
    } finally {
      this.depth -= 1
      if (this.depth === 0) this.flush()
    }
  }

  /** Run `step` now, or once the outermost scope has ended. */
  defer(step: () => void): void {
    if (this.depth > 0) this.deferred.push(step)
    else step()
  }

  /**
   * Open a turn: `mark` sets it opened, `begin` takes its lifecycle
   * admission and `announce` emits its opening. Outside the scope all three
   * run now, in that order. Inside it, the admission is taken now and the
   * rest once the scope ends, unless the turn is `settled()` by then (a stop
   * meanwhile settled it unopened).
   */
  openTurn(steps: { mark(): void; begin(): void; announce(): void; settled(): boolean }): void {
    if (this.depth === 0) return void (steps.mark(), steps.begin(), steps.announce())
    steps.begin()
    this.defer(() => void (steps.settled() || (steps.mark(), steps.announce())))
  }

  private flush(): void {
    while (this.deferred.length > 0 && this.depth === 0) this.deferred.shift()!()
  }
}
