// Lifecycle decision table, INPUTS ONLY (design "Lifecycle decision table",
// task 1.3). Observable results are deliberately absent: a blind reader of
// another model family derives them from the delta specs, and the resolved
// results are added beside these rows after that reading. Rows with state or
// operation sets expand to every member; `U01`/`U02` are the unreachable
// pairs: no process exists while unstarted and no state returns to it.

export const STATES = ['unstarted', 'starting', 'idle', 'active', 'stopping', 'stopped', 'exited'] as const
export const OPERATIONS = ['start', 'send', 'interrupt', 'stop', 'exit', 'ready', 'result', 'native'] as const

export type LifecycleState = (typeof STATES)[number]
/** `stop` is kill or shutdown; `exit` an unrequested process end; `ready`/`result` runtime completions;
 * `native` runtime input that opens a turn without `send` (Claude `init`, Codex `turn/started`). */
export type LifecycleOperation = (typeof OPERATIONS)[number]

export interface LifecycleRow {
  id: string
  states: readonly LifecycleState[]
  operations: readonly LifecycleOperation[]
  /** Set on rows whose pairs cannot occur. */
  unreachable?: true
}

export const LIFECYCLE_ROWS: readonly LifecycleRow[] = [
  { id: 'L01', states: ['unstarted'], operations: ['start'] },
  { id: 'L02', states: ['exited'], operations: ['start'] },
  { id: 'L03', states: ['starting'], operations: ['start'] },
  { id: 'L04', states: ['idle', 'active'], operations: ['start'] },
  { id: 'L05', states: ['unstarted', 'exited'], operations: ['send'] },
  { id: 'L06', states: ['starting'], operations: ['send'] },
  { id: 'L07', states: ['idle'], operations: ['send'] },
  { id: 'L08', states: ['active'], operations: ['send'] },
  { id: 'L09', states: ['unstarted', 'idle', 'exited'], operations: ['interrupt'] },
  { id: 'L10', states: ['starting', 'active'], operations: ['interrupt'] },
  { id: 'L11', states: ['unstarted', 'starting', 'idle', 'active', 'exited'], operations: ['stop'] },
  { id: 'L12', states: ['stopping', 'stopped'], operations: ['stop'] },
  { id: 'L13', states: ['stopping', 'stopped'], operations: ['start', 'send', 'interrupt'] },
  { id: 'L14', states: ['starting', 'idle', 'active'], operations: ['exit'] },
  { id: 'L15', states: ['stopping'], operations: ['exit'] },
  { id: 'L16', states: ['stopped', 'exited'], operations: ['exit'] },
  { id: 'L17', states: ['starting'], operations: ['ready'] },
  { id: 'L18', states: ['idle', 'active', 'stopping', 'stopped', 'exited'], operations: ['ready'] },
  { id: 'L19', states: ['active'], operations: ['result'] },
  { id: 'L20', states: ['starting', 'idle', 'stopping', 'stopped', 'exited'], operations: ['result'] },
  { id: 'L24', states: ['idle'], operations: ['native'] },
  { id: 'L25', states: ['active'], operations: ['native'] },
  { id: 'L26', states: ['starting', 'stopping', 'stopped', 'exited'], operations: ['native'] },
  { id: 'U01', states: ['unstarted'], operations: ['exit'], unreachable: true },
  { id: 'U02', states: ['unstarted'], operations: ['ready', 'result', 'native'], unreachable: true },
]

/** Explicit continuation rows, outside the 56-pair grid. */
export const CONTINUATION_ROWS = [
  { id: 'L21', runtime: 'claude', state: 'active', continuation: 'queue' },
  { id: 'L22', runtime: 'codex', state: 'active', continuation: 'steer' },
  { id: 'L23', runtime: 'either', state: 'active', continuation: 'unsupported mode' },
] as const

/** Lifecycle invariants checked by seeded sequences over the same axes. */
export const LIFECYCLE_INVARIANTS = [
  { id: 'I1', claim: 'Stop receipt never precedes actual owned process exits/JS join', seed: 0xa601, sequences: 300 },
  { id: 'I2', claim: 'A saved runtime ID resumes the same conversation; invalid/unsaved identity never silently creates one', seed: 0xa602, sequences: 300 },
] as const

/** Every (state, operation) pair and the row ids that cover it. */
export function expandPairs(rows: readonly LifecycleRow[]): Map<string, string[]> {
  const cover = new Map<string, string[]>()
  for (const state of STATES) for (const operation of OPERATIONS) cover.set(`${state}+${operation}`, [])
  for (const row of rows) {
    for (const state of row.states) {
      for (const operation of row.operations) {
        const key = `${state}+${operation}`
        const ids = cover.get(key)
        if (!ids) throw new Error(`${row.id}: unknown pair ${key}`)
        ids.push(row.id)
      }
    }
  }
  return cover
}

/** Pairs covered by no row (gaps) or by more than one (overlaps). */
export function completenessErrors(rows: readonly LifecycleRow[]): string[] {
  const errors: string[] = []
  for (const [pair, ids] of expandPairs(rows)) {
    if (ids.length === 0) errors.push(`gap: ${pair}`)
    else if (ids.length > 1) errors.push(`overlap: ${pair} (${ids.join(', ')})`)
  }
  return errors
}
