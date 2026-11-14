// One adapter's package-driver lifecycle (task 6.1), shared by the Claude and
// Codex adapters:
// - One boot at a time; a live driver is reused, and a stopped adapter boots
//   nothing.
// - A respawn retires the previous owner strictly. Its kill must resolve, or
//   reject only with causes this boot already heard (quiesced()): the exits
//   onProcessEnd reported, and the driver's own start failure, which its
//   stop reports again. Anything else refuses the respawn.
// - A start that fails is over for that driver even when no process exists
//   to report an exit, so the next ensure respawns. The failure is reported
//   once through `failed`, unless the process already reported its exit or
//   the adapter's own stop cancelled the start.
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import { exitCause, quiesced } from './codexRuntimeSupport'
import type { OwnedWork } from './runtimeOwnership'

interface PackageDriver {
  start(): Promise<unknown>
  kill(): Promise<unknown>
}

export class RuntimeBoot<D extends PackageDriver> {
  private driver: D | null = null
  private ended = false
  private pending: Promise<D | null> | null = null
  /** The current driver's reported exits, in the package's cause text. */
  private exits: string[] = []
  /** The current driver's start failure, already reported. */
  private heard: unknown[] = []

  constructor(
    private readonly owned: OwnedWork,
    private readonly stopped: () => boolean,
    /** The refusal when the previous owner did not quiesce. */
    private readonly unclean: string,
  ) {}

  /** The newest driver, ended or not. */
  get current(): D | null {
    return this.driver
  }

  /** The newest driver while it has not ended. */
  get live(): D | null {
    return this.driver && !this.ended ? this.driver : null
  }

  /** The boot in progress, if any. */
  get booting(): Promise<D | null> | null {
    return this.pending
  }

  /** The package reported the current driver's process exit. */
  exited(report: { generation: number; code: number | null; signal: string | null }): void {
    this.exits.push(exitCause(report.generation, report.code, report.signal))
    this.ended = true
  }

  /**
   * The live driver, or a new one. `prepare` runs synchronously first (a
   * refusal it throws refuses the caller) and returns the creation step,
   * which runs once the previous owner quiesced.
   */
  ensure(prepare: () => () => Promise<D | null> | D | null, failed: (error: unknown) => void): Promise<D | null> {
    if (this.stopped()) return Promise.resolve(null)
    if (this.pending) return this.pending
    const live = this.live
    if (live) return Promise.resolve(live)
    const create = prepare()
    const previous = this.driver
    let created: D | null = null
    const boot = (async (): Promise<D | null> => {
      if (previous) {
        const exits = this.exits
        const heard = this.heard
        const quiet = await previous.kill().then(() => true, (error: unknown) => {
          void this.owned.track('retire', Promise.reject(error))
          return quiesced(error, exits, heard)
        })
        if (!quiet) throw new Error(this.unclean)
      }
      if (this.stopped()) return null
      const inner = await create()
      if (!inner) return null
      this.driver = created = inner
      this.exits = []
      this.heard = []
      this.ended = false
      await inner.start()
      return inner
    })()
    const settled = boot.catch((error: unknown) => {
      // The start our own stop cancelled is that stop's consequence, not a failure.
      if (this.stopped() && error instanceof AgentRuntimeError && error.category === 'stopped') return null
      // A process that died while booting already reported its exit.
      if (!this.stopped() && !(this.driver && this.ended)) failed(error)
      if (created && this.driver === created) {
        this.ended = true
        this.heard.push(error)
      }
      throw error
    })
    void this.owned.track('start', settled)
    const ready = settled.then((inner) => inner, () => null).finally(() => {
      if (this.pending === ready) this.pending = null
    })
    this.pending = ready
    return ready
  }
}
