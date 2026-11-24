# Oracle binding (A2)

This file binds the acceptance oracles after the blind reading. The inputs are in `oracle-blind-inputs.md` (A1). The author's outputs are in `design.md`, "Acceptance oracles", unchanged since the reviewed proposal. The independent reading agreed with the author's outputs on every row O1–O16 and on the corrected P1. It did not supply log spellings, seeds or case counts; those come from design D2, D3 and "Properties", not from the reading.

Below, the reading's qualifications are resolved without changing any output, generator or decision.

## Evaluation order (the reference model)

One application of the follow-on, for a task in status `s` with prior acceptances `H`, is decided by three stages in order. The first stage that decides wins.

1. **Terminal.** `s` is `done` or `cancelled`: no identity is resolved and `accept` is not called. `H` and `s` are unchanged, and no identity-refusal or accept-failure event is logged. This covers O12, O13 and O15, whatever the reference, row, commit, pin, mechanism or siblings are.
2. **Identity.** `s` is `open`, `active` or `blocked`. The checks run in this order: `no-round`, `round-missing`, `round-mismatch`, `commit-mismatch`. The first check that fails decides. `H` and the exact status `s` are unchanged, and `plan_execution_accept_identity_refused` is logged with that reason. This covers O8–O11.
3. **Accept.** `accept` is called with the authorizing round's `resultId`.
   - If the pin is current, `H ∪ {(R, Kawai)}` and the task is `done` (O1–O7, O16).
   - If the pin is older, `TaskResultService` refuses for want of a stated reason: `H` and `s` are unchanged, and `plan_execution_accept_failed` is logged (O14).

The outcome is a function of `(s, the identity check, the pin)` only. Several things never change the outcome:

- the mechanism;
- the siblings: earlier, later or newly submitted results and rounds;
- the round outcomes and their insertion order;
- carried and re-gate provenance;
- a restart before the follow-on.

The landing fact, the `landed` transition, cleanup and completion are the same in every stage (contract I4).

The tests implement this model once, as a pure `expected(state)` function. The table rows and properties P1–P3 assert against it. A test also checks that the model reproduces each O1–O16 output verbatim, so the model cannot drift from the table.

## Coverage qualifications

- **Open means three statuses.** Rows whose task is open (O1–O11, O14, O16) each run under `open`, `active` and `blocked`. Each refusal asserts that the exact input status is preserved.
- **The rows are examples, not a partition.** Sibling labels can be combined: an earlier round, a later round and a new submission can coexist. O16 is O2 plus a restart event. No completeness claim rests on the 16 rows. Completeness is the reference model above, and P1 and P2 combine the sibling, carried and re-gate axes.
- **Mechanism independence.** Both call sites, the direct merge follow-on and `fastForwarded`, call the one `afterLanded` with a `LandedStep`. The table rows that are not run through composition run at that seam, so the identity rule cannot differ by mechanism. Mechanism-specific wiring is proven through the production composition:
  - direct: O1, O2, O6, O16;
  - integration: O3, plus an integration identity refusal, plus an integration row with no siblings.
  - Wiring mutants M6 and M7 must each fail a composition test.
- **P1 generator provenance.** The published generator is kept as it is: the authorizing round is drawn uniformly among the rounds whose commit equals the landed head, whatever their outcome. Each case is labelled:
  - `normal` when the authorizer is a passed or carried round;
  - `defensive` otherwise, meaning a store-level history that production would not write.

  The property is the same for both labels, per D2: the outcome is not re-checked and no outcome guard is added. The test reports the per-label counts and requires both labels to occur. Both are required: the `normal` cases make the property meaningful for production histories, and the `defensive` cases keep D2's no-recheck rule under test.
- **Fixed counterexamples.** Before its random cases, P1 runs the counterexamples that motivated its correction:
  - a human accepted another result `X ≠ R` before the follow-on (O12 shape);
  - Kawai already accepted `R` and the follow-on is replayed (O15 shape).
- **P3 holds the input fixed.** The task revision and every other input stay fixed between repeated runs; the only allowed change is the optional human accept or cancel before the first run. Each run asserts:
  - the acceptance rows, with their acceptors and acceptance times;
  - the task's journal entry count;
  - the single landing fact.

## Binding obligations from the mechanism challenge

The Lead recorded these as binding when the challenge closed. Each is an evidence obligation inside the approved scope; none changes an output.

- **Finite-axis completeness.** One test enumerates the full product of the finite axes:
  - status: `open`, `active`, `blocked`, done by a human, done by Kawai, `cancelled`;
  - reference: valid, `null`, missing, another execution, another change, wrong commit;
  - pin: current, older;
  - mechanism: direct, integration.

  It asserts two things. First, each input falls in exactly one ordered class: terminal, one identity reason, stale, or accepted. Second, the follow-on produces that class's outcome at the `afterLanded` seam. The completeness claim rests on this enumeration, not on a random case count.
- **Terminal precedence covers invalid references.** For a done or cancelled task, every combination of an invalid reference with either pin age asserts all of the following:
  - no `plan_execution_accept_identity_refused` or `plan_execution_accept_failed` event;
  - no `accept` call: the double records its calls and checks the arguments it receives;
  - the acceptance ids and acceptors are unchanged;
  - the journal entry count and the status are unchanged.

  M8 as written moves resolution before the guard *and* accepts regardless of status. A separate ordering control moves only the resolver, logging its refusal, before the guard. That control must fail the terminal-with-invalid-reference test. Killing M8 is not cited as evidence for the ordering case.
- **No outcome guard.** P1 keeps the full `{superseded, fail, pass}` outcome generator. Defensive histories are store-level, such as O7 or a round superseded after authorization. In those histories identity-based acceptance still applies when the authorizer's current outcome is fail or superseded. Normal provenance is described separately: the planner skips result replacement while a change is `landing`. No generated case is filtered out.
- **Rows versus classes.** The 16 rows are named examples. The classes are those of the finite-axis enumeration. History variants are covered by P1 and P2 for both mechanisms: carried, re-gate, later result, later round, new submission and replay. Event variants are covered the same way; O16's restart is one.
- **P3 reachable initial histories.** P3 starts from one of three reachable prior states:
  - no acceptance;
  - one human acceptance, by accept or cancel;
  - one earlier Kawai acceptance of the authorizing result.

  Prior history is never erased to satisfy "at most one acceptance". Each replay compares the prior acceptance rows field by field (id, acceptor, time), the journal entry count and the exact status.

## Left to their existing owners (not new rows)

These are not normative rows of this change. The existing owners and suites keep them:

- a task row that is null;
- a referenced result that is missing or belongs to another task, and a task with open children: refused by `TaskResultService.accept`, keeping the existing catch, log, cleanup and completion;
- an explicit stated reason for a stale acceptance: the follow-on never supplies one;
- the crash window between `landed` and acceptance (design X2; task contract X1).
