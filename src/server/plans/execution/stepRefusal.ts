// A step's refused service call (plan-execution D12, I2): the task,
// assignment, and result services throw on refusal — an unknown task, a
// request key reused with a different field, an unlisted worktree or group.
// Such a refusal is deterministic, so retrying it every tick would loop
// forever; the executor stops the change as `instruction-failed` with the
// stage and the refusal text instead, and Retry dispatches it again. A
// database error is not a refusal: it passes through and ends the tick.

/** A step's service call refused; carries the stage and the refusal text. */
export class StepRefusal extends Error {
  constructor(readonly stage: string, readonly refusal: string) {
    super(`The ${stage} step was refused: ${refusal}`)
    this.name = 'StepRefusal'
  }
}

/** Run one service call of a step; its refusal becomes a StepRefusal. */
export async function refusable<T>(stage: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof StepRefusal) throw error
    if (error instanceof Error && error.name !== 'SQLiteError') throw new StepRefusal(stage, error.message)
    throw error
  }
}
