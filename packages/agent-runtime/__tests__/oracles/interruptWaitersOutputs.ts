// Resolved results for the interrupt-versus-waiting-sends tables (task 4.4
// Claude checkpoint unit, R3 A4). Derived blind by the reader (notes
// 5ed7418a and 317de3ca) from the inputs committed at 81c49d5c and babb659d,
// compared with the author's withheld outputs (note-da913074) and bound by
// the lead (notes 0250bfda and ffdb1641). Each regression test cites its row.
//
// C = the waiting send is refused at once with category not-ready, code
// interrupted, before the held start or persistence is released; that call
// never enqueues, emits user_message or turn_started, or returns a handle,
// even after the release. Every interrupt receipt has processExit false.
// The persistence and the start are not cancelled: they stay owned work the
// stop joins, and their own failures are kept.

export const WAITER_OUTPUTS: Readonly<Record<string, string>> = {
  W01: 'no-active-turn; state unchanged. A held persistence with no waiting send is not a waiter.',
  W02: 'requested (the existing starting policy); initialization stays owned; no turn, no exit.',
  W03: 'requested; the active turn settles interrupted once; queued submissions settle interrupted; idle.',
  W04: 'refused, category stopped (L13), before any mutation.',
  W05: 'C; requested; initialization continues; state stays starting.',
  W06: 'refused stopped (L13); the waiting send is refused stopped once start settles; it is never accepted.',
  W07: 'C; requested; the active turn is interrupted; idle.',
  W08: 'C; requested; stays idle; the earlier T0 result is unchanged.',
  W09: 'C; requested; stays idle.',
  W10: 'C; requested; the agent-started turn is interrupted; idle. The send is cancelled, not refused busy.',
  W11: 'C; requested; the restart continues as owned work.',
  W12: 'C; requested; stays exited; no restart.',
  W13: 'refused stopped (L13); the waiting send is refused stopped after the persistence settles (the stop joins it).',
  W14: 'C; requested; idle stays idle, active interrupts its turn, exited stays exited.',
  W15: 'refused stopped (L13); a send still undecided is refused stopped; nothing reopens.',
  W16: 'C if the send is still undecided (first settlement); start() keeps its own rejection. See F01/F03.',
  U11: 'unreachable.',
  WR1: 'no-active-turn.',
  WR2: 'requested.',
  WR3: 'requested (starting keeps its existing policy; active interrupts its turn).',
  WR4: 'requested; C for every pre-existing waiter.',
  WR5: 'refused stopped.',
  WA1: 'the cancelled send stays refused; nothing is sent; later sends are accepted under the usual admission and FIFO rules.',
  WA2: 'the cancelled send stays refused interrupted; the rejection is still sticky (later sends refused checkpoint), observable (error event) and disposes the driver; the stop reports the raw cause.',
  WA3: 'the new send is new work: it waits for the persistence and is accepted after it succeeds (refused checkpoint if it rejects); queue accounting is intact.',
  WA4: 'the stop waits for the persistence; it fails with the raw cause if the persistence rejects.',
  WA5: 'the second interrupt cancels only what exists when it is entered; with nothing new, idle or exited gives no-active-turn.',
  WA6: 'same rules from inside onCheckpoint; it never waits on its own persistence; requested if waiters existed, else per state.',
}

export const SUPPLEMENT_OUTPUTS: Readonly<Record<string, string>> = {
  X01: 'C; requested.',
  X02: 'C; requested; the active turn is interrupted.',
  X03: 'C; requested; stays exited.',
  X04: 'refused stopped (L13); the send is refused stopped.',
  X05: 'C; requested; the restart stays owned.',
  X06: 'guarded: refused stopped; the send is refused stopped; nothing reopens.',
  U21: 'unreachable.',
  F01: 'C (the interrupt is the first settlement); start() keeps its own rejection; requested.',
  F02: 'C; requested.',
  F03: 'the refusal already settled stands; no waiter, so no-active-turn.',
  R01: 'C; requested; never enqueued.',
  R02: 'C; requested; the rejection stays sticky for later sends, with the error event and disposal; the stop reports the raw cause.',
  C01: 'A gets C; B registered after the interrupt was entered: new work, it waits for the persistence and is accepted after it succeeds.',
  C02: 'the nested interrupt finds A already decided and cancels nothing new; A is refused exactly once.',
  C03: 'the kill begins the stop and does not take over A: A gets C; later sends are refused stopped; nothing returns to idle.',
  C04: 'as C01, for a send made from the interrupt event.',
  B01: 'A gets C; nothing is enqueued and no handle is returned; requested.',
  B02: 'A refused stopped; nothing is enqueued.',
  B03: 'A and W are both undecided when the interrupt is entered: both get C; requested.',
  B04: 'A refused by beforeSubmit (category context); the following interrupt finds no waiter.',
  P01: 'A keeps its handle; its turn settles interrupted exactly once with A identity; no not-ready refusal, no duplicate result.',
  P02: 'as P01, for the user_message publication.',
}
