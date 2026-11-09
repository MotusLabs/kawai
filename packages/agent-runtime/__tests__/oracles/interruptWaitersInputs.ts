// Interrupt versus waiting sends, INPUTS ONLY (task 4.4 Claude checkpoint
// unit, R3 A4; refines lifecycle rows L06/L09/L10/L13 for sends that have not
// been acknowledged yet). Observable results are deliberately absent: a blind
// reader of another model family derives them from the delta specs and the
// R3 contract, and the resolved results are added beside these rows after
// that reading.
//
// A "waiter" is one send() call that has been made but has neither returned
// a handle nor been refused when interrupt() is called. Its kind says what it
// is waiting for:
// - none: no send is waiting (the interrupt has nothing pending to cancel).
// - start: the driver is starting; the send waits for initialization (L06).
// - persistence-queue: a send with continuation `queue`, held because a
//   runtime identity checkpoint (onCheckpoint) has not settled yet.
// - persistence-default: a send with the default continuation (new-turn),
//   held for the same reason; it was called while idle, so it was not busy.
// The state is the driver state when interrupt() is called. Several waiters
// may exist at once; each is decided by its own (state, kind) row, and the
// interrupt receipt is decided by WAITER_RECEIPT_ROWS below.

export const WAITER_STATES = ['unstarted', 'starting', 'idle', 'active', 'stopping', 'stopped', 'exited'] as const
export const WAITER_KINDS = ['none', 'start', 'persistence-queue', 'persistence-default'] as const

export type WaiterState = (typeof WAITER_STATES)[number]
export type WaiterKind = (typeof WAITER_KINDS)[number]

export interface WaiterRow {
  id: string
  states: readonly WaiterState[]
  kinds: readonly WaiterKind[]
  /** How the pair arises, so a reader can check it is reachable. */
  arises: string
  /** Set on rows whose pairs cannot occur, with the reason. */
  unreachable?: string
}

export const WAITER_ROWS: readonly WaiterRow[] = [
  { id: 'W01', states: ['unstarted', 'idle', 'exited'], kinds: ['none'], arises: 'interrupt with no send pending (true idle, never started, or after an unexpected exit)' },
  { id: 'W02', states: ['starting'], kinds: ['none'], arises: 'interrupt during start() with no send pending' },
  { id: 'W03', states: ['active'], kinds: ['none'], arises: 'interrupt of the active turn with no send pending' },
  { id: 'W04', states: ['stopping', 'stopped'], kinds: ['none'], arises: 'interrupt after stop began' },
  { id: 'W05', states: ['starting'], kinds: ['start'], arises: 'send() during start(), awaiting initialization' },
  { id: 'W06', states: ['stopping'], kinds: ['start'], arises: 'send() during start(); stop() began before initialization settled' },
  { id: 'W07', states: ['active'], kinds: ['persistence-queue'], arises: 'T0 active, its init revealed a new id, onCheckpoint P held; send(queue)' },
  { id: 'W08', states: ['idle'], kinds: ['persistence-queue'], arises: 'as W07, then T0 result arrived and the driver became idle; P still held' },
  { id: 'W09', states: ['idle'], kinds: ['persistence-default'], arises: 'T0 ended while P held; then send() with the default continuation' },
  { id: 'W10', states: ['active'], kinds: ['persistence-default'], arises: 'as W09, then the CLI opened an agent-started turn (native init) while P still held' },
  { id: 'W11', states: ['starting'], kinds: ['persistence-queue', 'persistence-default'], arises: 'a send held on P; the process exited unexpectedly and start() was called again; P still held' },
  { id: 'W12', states: ['exited'], kinds: ['persistence-queue', 'persistence-default'], arises: 'a send held on P; the process exited unexpectedly; P still held' },
  { id: 'W13', states: ['stopping'], kinds: ['persistence-queue', 'persistence-default'], arises: 'a send held on P; stop() began; P still held (stop joins P)' },
  { id: 'U11', states: ['unstarted'], kinds: ['start', 'persistence-queue', 'persistence-default'], arises: '-', unreachable: 'send() before start() is refused at once (L05); no identity can be known before a turn' },
  { id: 'W14', states: ['idle', 'active', 'exited'], kinds: ['start'], arises: 'initialization settled (then a native turn opened, or the process ended) but the send waiting on it has not resumed yet' },
  { id: 'W15', states: ['stopped'], kinds: ['start', 'persistence-queue', 'persistence-default'], arises: 'the stop joined start and P and completed, but a send waiting on them has not resumed yet' },
]

/** The receipt rows: decided by the state and whether any waiter existed. */
export const WAITER_RECEIPT_ROWS = [
  { id: 'WR1', states: ['unstarted', 'idle', 'exited'], waiters: 'none' },
  { id: 'WR2', states: ['unstarted', 'idle', 'exited'], waiters: 'at least one' },
  { id: 'WR3', states: ['starting', 'active'], waiters: 'none' },
  { id: 'WR4', states: ['starting', 'active'], waiters: 'at least one' },
  { id: 'WR5', states: ['stopping', 'stopped'], waiters: 'any' },
] as const

/**
 * What happens after an interrupt that met a persistence waiter (W07-W12).
 * The reader decides, for each: the waiter's settlement and when it happens
 * relative to P's settlement, what a later send gets, and what the stop reports.
 */
export const AFTER_INTERRUPT_ROWS = [
  { id: 'WA1', event: 'P resolves after the interrupt' },
  { id: 'WA2', event: 'P rejects after the interrupt' },
  { id: 'WA3', event: 'a NEW send(queue or default) is made after the interrupt, before P settles' },
  { id: 'WA4', event: 'stop() is called after the interrupt, before P settles' },
  { id: 'WA5', event: 'the same send is interrupted twice (a second interrupt after the first)' },
  { id: 'WA6', event: 'interrupt() is called from inside onCheckpoint while that P is running' },
] as const

/** Every (state, kind) pair and the row ids that cover it. */
export function expandWaiterPairs(rows: readonly WaiterRow[]): Map<string, string[]> {
  const cover = new Map<string, string[]>()
  for (const state of WAITER_STATES) for (const kind of WAITER_KINDS) cover.set(`${state}+${kind}`, [])
  for (const row of rows) {
    for (const state of row.states) {
      for (const kind of row.kinds) {
        const key = `${state}+${kind}`
        const ids = cover.get(key)
        if (!ids) throw new Error(`${row.id}: unknown pair ${key}`)
        ids.push(row.id)
      }
    }
  }
  return cover
}

/** Pairs covered by no row (gaps) or by more than one (overlaps). */
export function waiterCompletenessErrors(rows: readonly WaiterRow[]): string[] {
  const errors: string[] = []
  for (const [pair, ids] of expandWaiterPairs(rows)) {
    if (ids.length === 0) errors.push(`gap: ${pair}`)
    else if (ids.length > 1) errors.push(`overlap: ${pair} (${ids.join(', ')})`)
  }
  return errors
}

/** Receipt rows cover each state once per waiter presence (none / at least one). */
export function receiptCompletenessErrors(rows: readonly { id: string; states: readonly string[]; waiters: string }[]): string[] {
  const errors: string[] = []
  for (const state of WAITER_STATES) {
    for (const presence of ['none', 'at least one']) {
      const ids = rows.filter((row) => row.states.includes(state) && (row.waiters === presence || row.waiters === 'any')).map((row) => row.id)
      if (ids.length === 0) errors.push(`gap: ${state}+${presence}`)
      else if (ids.length > 1) errors.push(`overlap: ${state}+${presence} (${ids.join(', ')})`)
    }
  }
  return errors
}
