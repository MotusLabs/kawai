// A call's outcome state, derived at read time (execution-safety-recovery
// D7): its terminal outcome when one exists (denied beats failed beats
// completed), else started-background, else pending while the agent process
// that made the call still lives, else outcome-unknown. The live-spawn set
// lives in memory only, so after a restart every settled-less call reads
// outcome-unknown — never re-run, never re-judged.
export type OutcomeState = 'denied' | 'failed' | 'completed' | 'started-background' | 'pending' | 'outcome-unknown'

/** The terminal precedence D7 fixes: denied, then failed, then completed. */
const PRECEDENCE = ['denied', 'failed', 'completed'] as const

export function outcomeState(input: {
  /** The outcome rows recorded for the call (`outcomesOf`, D6). */
  outcomes: Array<{ outcome: string }>
  /** Whether the spawn that made the call is still live (the observer's set). */
  spawnLive: boolean
}): OutcomeState {
  for (const terminal of PRECEDENCE) {
    if (input.outcomes.some(row => row.outcome === terminal)) return terminal
  }
  if (input.outcomes.some(row => row.outcome === 'started-background')) return 'started-background'
  return input.spawnLive ? 'pending' : 'outcome-unknown'
}
