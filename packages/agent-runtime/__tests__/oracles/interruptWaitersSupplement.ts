// Interrupt versus waiting sends, SUPPLEMENT, INPUTS ONLY (task 4.4 Claude
// checkpoint unit, R3 A4; lead bindings note-0250bfda). It adds only the cases
// the first table (interruptWaitersInputs.ts) did not express. Observable
// results are deliberately absent until a blind reader fills them.
//
// Definitions used by both tables:
// - A send is DECIDED when the driver has committed its outcome: a refusal
//   it settled, or acceptance (the point after which the prompt is enqueued
//   and published). A failure that has happened but has not been committed
//   (for example a rejected start the send has not observed yet) leaves the
//   send undecided. A waiter is an undecided send.
// - A waiter's kind is its ORIGINAL wait reason, kept after the cause
//   settled, until the send is decided.
// - PRE-EXISTING for an interrupt means a waiter at the moment interrupt()
//   is entered, before any host callback the interrupt itself triggers.

import { WAITER_STATES, type WaiterState } from './interruptWaitersInputs.js'

/**
 * The fifth wait reason: the send is in its initial admission yield with
 * nothing pending (no start in progress, no persistence pending, or no
 * onCheckpoint at all). It has been admitted provisionally but not decided.
 */
export interface AdmissionRow {
  id: string
  states: readonly WaiterState[]
  arises: string
  unreachable?: string
}

export const ADMISSION_ROWS: readonly AdmissionRow[] = [
  { id: 'X01', states: ['idle'], arises: 'send() (default or queue) while idle, interrupt in the same tick' },
  { id: 'X02', states: ['active'], arises: 'send(queue) while active, interrupt in the same tick' },
  { id: 'X03', states: ['exited'], arises: 'send() admitted while idle or active; the process ended before the send resumed' },
  { id: 'X04', states: ['stopping'], arises: 'send() admitted; stop() began before the send resumed' },
  { id: 'U21', states: ['unstarted'], arises: '-', unreachable: 'send() before start() is refused and decided at once (L05)' },
  { id: 'U22', states: ['starting'], arises: '-', unreachable: 'a send made while starting waits on start: kind start (first table)' },
  { id: 'U23', states: ['stopped'], arises: '-', unreachable: 'stopped follows the stop joining owned work over several turns of the event loop; a one-yield admission resumes first' },
]

/** Conditional cases, each one trace on the production session. */
export const CONDITIONAL_ROWS = [
  // A start that failed while a send waited on it, before the send resumed.
  { id: 'F01', state: 'unstarted', trace: 'start() rejects (first start); a send waiting on it has not observed the rejection; interrupt()' },
  { id: 'F02', state: 'exited', trace: 'start() after an unexpected exit rejects; a send waiting on it has not observed the rejection; interrupt()' },
  { id: 'F03', state: 'unstarted', trace: 'start() rejects and the waiting send has already been refused (decided); interrupt()' },
  // Original wait reason after its cause settled.
  { id: 'R01', state: 'idle', trace: 'a send held on P; P resolves; the send has not resumed; interrupt()' },
  { id: 'R02', state: 'idle', trace: 'a send held on P; P rejects; the send has not resumed; interrupt()' },
  // Host callbacks the interrupt itself triggers (pre-existing boundary).
  { id: 'C01', state: 'active', trace: 'waiter A held on P; interrupt(); onState(idle) during it calls send(B, default)' },
  { id: 'C02', state: 'active', trace: 'waiter A held on P; interrupt(); onState(idle) during it calls interrupt() again' },
  { id: 'C03', state: 'active', trace: 'waiter A held on P; interrupt(); onState(idle) during it calls kill()' },
  { id: 'C04', state: 'active', trace: 'waiter A held on P; interrupt(); an onEvent(turn_interrupted) during it calls send(B, queue)' },
  // beforeSubmit (the host submission check, P12/P13) after admission.
  { id: 'B01', state: 'idle', trace: 'send(A) admitted; its beforeSubmit calls interrupt() and then accepts' },
  { id: 'B02', state: 'idle', trace: 'send(A) admitted; its beforeSubmit calls kill() and then accepts' },
  { id: 'B03', state: 'idle', trace: 'send(A) admitted while waiter W is held on P; A beforeSubmit calls interrupt() and then accepts' },
  { id: 'B04', state: 'idle', trace: 'send(A) admitted; its beforeSubmit refuses; an interrupt follows' },
  // After acceptance: publications of the accepted send.
  { id: 'P01', state: 'idle', trace: 'send(A) accepted; onState(active) during its turn_started publication calls interrupt()' },
  { id: 'P02', state: 'idle', trace: 'send(A) accepted; onEvent(user_message) for A calls interrupt()' },
] as const

/** Every state appears once in the admission rows. */
export function admissionCompletenessErrors(rows: readonly AdmissionRow[]): string[] {
  const errors: string[] = []
  for (const state of WAITER_STATES) {
    const ids = rows.filter((row) => row.states.includes(state)).map((row) => row.id)
    if (ids.length === 0) errors.push(`gap: ${state}+admission`)
    else if (ids.length > 1) errors.push(`overlap: ${state}+admission (${ids.join(', ')})`)
  }
  return errors
}
