// The execution runtime (plan-execution D5): the one composition-side
// lifecycle around the executor — boot order, wake subscriptions, and stop.
// Boot runs D14 startup recovery first (no tick before it ends), installs
// the D5 wakes, then wakes every team that holds a running execution. The
// wakes fire only for tasks a running execution owns: task rows, result and
// finding writes, and mail bound to an owned task; a committed Start, Stop,
// or Retry command wakes directly (ExecutionService's own hook); member
// release and every archive land in `archived`, which wakes the archived
// session's team while it runs an execution. Stop unbinds the wakes and
// closes the executor, clearing its timer and refusing new ticks.
import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TaskStore } from '../../team/taskStore'
import type { ExecutionOwnership } from './executionOwnership'
import type { ExecutionStore } from './executionStore'
import type { ExecutionExecutor } from './executor'

/** What the wakes hub forwards to once the runtime is bound. */
interface WakeSink {
  wake(teamId: string): void
  sessionArchived(sessionId: string): void
}

/**
 * The mutable hub the early-constructed services emit through: the team
 * services exist before the executor (they take the ownership the store
 * mints), so their writes land here and reach the executor only once the
 * runtime binds it — after startup recovery, never before.
 */
export class ExecutionWakes {
  private sink: WakeSink | null = null

  constructor(private readonly store: ExecutionStore, private readonly ownership: ExecutionOwnership) {}

  /** A result or findings write (TaskResultService's hook). */
  readonly resultWrite = (taskId: string): void => {
    const owner = this.ownership.ownerOfTask(taskId)
    const teamId = owner === null ? undefined : this.store.execution(owner.executionId)?.teamId
    if (teamId !== undefined) this.sink?.wake(teamId)
  }

  /** A session was archived (member release, task-close release, or the human). */
  readonly archived = (sessionId: string): void => {
    this.sink?.sessionArchived(sessionId)
  }

  /** The runtime binds after startup recovery; `null` unbinds on stop. */
  bind(sink: WakeSink | null): void {
    this.sink = sink
  }
}

export interface ExecutionRuntimeDeps {
  executor: ExecutionExecutor
  store: ExecutionStore
  ownership: ExecutionOwnership
  wakes: ExecutionWakes
  /** Task rows of owned tasks (status transitions, amendments, claims). */
  taskStore: TaskStore
  /** Mail bound to an owned task (dispatch, delivery, claims, receipts). */
  mailbox: MailboxStore
  records: () => Iterable<ChatSessionRecord>
  teamOf: (sessionId: string) => TeamIdentity | undefined
  /** Which adapters the executor runs (the default composition proves its identity). */
  adapters?: { fixture: boolean; rounds: unknown }
}

export class ExecutionRuntime {
  private readonly unsubscribes: Array<() => void> = []
  private started = false
  private stopped = false

  /** The adapters the composed executor runs: the real module objects, or the fixture's. */
  readonly adapters: { fixture: boolean; rounds: unknown }

  constructor(private readonly deps: ExecutionRuntimeDeps) {
    this.adapters = deps.adapters ?? { fixture: false, rounds: null }
  }

  /**
   * Boot (D14 then D5): startup recovery runs to its end before any wake is
   * installed, so no tick can interleave with the effect inspections; then
   * the orphan landing slots every team accumulated before the restart are
   * cleared, then the wakes, then one wake per team that holds a running
   * execution — a restart resumes its loop and re-arms its timer.
   */
  async start(): Promise<void> {
    if (this.stopped) return
    await this.deps.executor.startup()
    if (this.stopped) return
    this.deps.store.clearOrphanSlots()
    this.install()
    this.started = true
    for (const teamId of this.deps.store.runningTeams()) this.deps.executor.wake(teamId)
  }

  /** A committed Start, Stop, or Retry command (D5): wakes once boot has ended. */
  command(teamId: string): void {
    if (this.started && !this.stopped) this.deps.executor.wake(teamId)
  }

  /** The in-flight tick, for callers that need to await the wake's work. */
  idle(): Promise<void> {
    return this.deps.executor.idle()
  }

  /** The D5 wake subscriptions; each fires only for owned tasks. */
  private install(): void {
    this.deps.wakes.bind({
      wake: teamId => this.wake(teamId),
      sessionArchived: sessionId => this.noteArchived(sessionId),
    })
    this.unsubscribes.push(this.deps.taskStore.subscribe(task => {
      const owner = this.deps.ownership.ownerOfTask(task.id)
      if (owner !== null) this.wake(task.teamId)
    }))
    this.unsubscribes.push(this.deps.mailbox.subscribe((teamId, message) => {
      if (message?.taskId !== undefined && message.taskId !== null
        && this.deps.ownership.ownerOfTask(message.taskId) !== null) this.wake(teamId)
    }))
  }

  private wake(teamId: string): void {
    if (!this.stopped) this.deps.executor.wake(teamId)
  }

  /** An archived session frees a worktree or a group slot its execution may wait on. */
  private noteArchived(sessionId: string): void {
    if (this.stopped) return
    const team = this.deps.teamOf(sessionId)
    if (team === undefined) return
    if (this.deps.store.runningForTeam(team.teamId).length > 0) this.wake(team.teamId)
  }

  /** Stop (shutdown): drop the wakes, clear the timer, refuse new ticks. */
  stop(): void {
    this.stopped = true
    this.deps.wakes.bind(null)
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
    this.deps.executor.close()
  }
}
