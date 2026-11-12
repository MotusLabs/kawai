// Public consumer supervisor. Import is inert: callers supply authorized
// launches, host answers, durable checkpoint storage and their own prompts.
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { AgentDriver, AgentCallbacks, ClaudeDriverOptions, CodexDriverOptions, ResumeCheckpoint, TurnResult, ProcessExitReceipt } from '@motuslabs/agent-runtime'

export type HeadlessProvider =
  | { runtime: 'claude'; options: Omit<ClaudeDriverOptions, 'callbacks' | 'resume'> }
  | { runtime: 'codex'; options: Omit<CodexDriverOptions, 'callbacks' | 'resume'> }

export interface HeadlessHost {
  load(runtime: 'claude' | 'codex'): ResumeCheckpoint | undefined
  save(checkpoint: ResumeCheckpoint): Promise<void>
  answers: Readonly<Record<string, string>>
  prompts: Record<'claude' | 'codex', { turns: readonly string[]; interrupt: string; resume: string }>
  /** Safe numeric/status facts only; never raw events, prompts or authority. */
  print(facts: object): void | Promise<void>
}

export interface HeadlessResult {
  turns: TurnResult[]
  stops: ProcessExitReceipt[]
}

/** Outside supervisor owns all stops; callbacks only answer and observe. */
export async function runHeadless(providers: readonly HeadlessProvider[], host: HeadlessHost): Promise<HeadlessResult> {
  const owned: AgentDriver[] = []
  const result: HeadlessResult = { turns: [], stops: [] }
  const failures: unknown[] = []
  const output: Array<Promise<PromiseSettledResult<void>>> = []
  let closing = false
  // Runtime observers are synchronous. This example owns async sinks itself;
  // each rejection is observed immediately and joined by the outside owner.
  const publish = (facts: object): void => {
    if (closing) return
    const printed = host.print(facts)
    if (printed) output.push((async (): Promise<PromiseSettledResult<void>> => {
      try {
        await printed
        return { status: 'fulfilled', value: undefined }
      } catch (reason) {
        return { status: 'rejected', reason }
      }
    })())
  }
  const construct = (provider: HeadlessProvider, resume?: ResumeCheckpoint) => {
    let driver: AgentDriver
    const callbacks: AgentCallbacks = {
      onEvent() {},
      onCheckpoint: (checkpoint) => host.save(checkpoint),
      onRequest(request) {
        if (request.kind === 'approval') driver.resolveApproval(request.requestId, 'deny')
        else driver.answerQuestion(request.requestId, Object.fromEntries(request.questions.map((question) => [question.question, { text: host.answers[question.question] ?? '' }])))
      },
      onTurnResult: (turn) => publish({ runtime: provider.runtime, outcome: turn.outcome, usage: turn.usage, toolCallCount: turn.toolCallCount, compactionCount: turn.compactionCount }),
      onLimitEvent: (event) => publish({ runtime: provider.runtime, limit: event.type, ...('cause' in event ? { cause: event.cause } : {}) }),
      onQuotaReport: (report) => publish({ runtime: provider.runtime, source: report.source, accountScope: report.accountScope, windows: report.windows.map((window) => ({ percentUsed: window.percentUsed, resetsAt: window.resetsAt })) }),
    }
    driver = provider.runtime === 'claude'
      ? createClaudeDriver({ ...provider.options, callbacks, ...(resume ? { resume } : {}) })
      : createCodexDriver({ ...provider.options, callbacks, ...(resume ? { resume } : {}) })
    owned.push(driver)
    return driver
  }
  try {
    for (const provider of providers) {
      const prompts = host.prompts[provider.runtime]
      const driver = construct(provider, host.load(provider.runtime))
      await driver.start()
      for (const prompt of prompts.turns) result.turns.push(await (await driver.send(prompt)).result)
      const pending = await driver.send(prompts.interrupt)
      const interrupt = await driver.interrupt()
      result.turns.push(await pending.result)
      await host.print({ runtime: provider.runtime, interrupt: interrupt.outcome, processExit: interrupt.processExit })
      result.stops.push(await driver.kill())
      const saved = host.load(provider.runtime)
      if (!saved) throw new Error(`No persisted ${provider.runtime} identity to resume`)
      const resumed = construct(provider, saved)
      await resumed.start()
      result.turns.push(await (await resumed.send(prompts.resume)).result)
      result.stops.push(await resumed.shutdown())
    }
  } catch (error) {
    failures.push(error)
  } finally {
    closing = true
    // allSettled attempts every stop, even after a primary or earlier stop
    // failure. No callback calls this owner or awaits its own disposal.
    const joined = await Promise.allSettled(owned.map(async (driver) => driver.shutdown()))
    for (const outcome of joined) if (outcome.status === 'rejected' && !failures.includes(outcome.reason)) failures.push(outcome.reason)
    for (const write of await Promise.all(output)) if (write.status === 'rejected') failures.push(write.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'headless run and cleanup failed')
  return result
}
