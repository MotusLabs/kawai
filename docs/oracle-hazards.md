# Oracle hazard catalog

Hazards that acceptance oracles have caught or should have caught, organized
by change class. Consult it while writing a design's "Acceptance oracles"
subsection (docs/agent-collaboration.md, "Write acceptance as oracles"), and
add an entry for every new blocking finding. What blocks — the P0/P1/P2
levels, the clause and evidence rules, dispositions, and disputes — is
defined once in docs/agent-collaboration.md, "Review protocol"; this
catalog never adds a blocking rule of its own. The reviewer reports a defect
outside the tables as a proposed oracle amendment, the Lead decides, and the
decision lands here. Each entry names the class, the hazard, the oracle row
or property that would have caught it, and the source finding.

## State machines with recovery

### B1 — the superseded actor's later writes (findings-60ea7371, RC E)

- **Hazard.** After a Restart, reassignment or forward, the old holder keeps
  writing — results, findings, checkpoints — and the tables have no row for
  an actor that was already superseded.
- **Oracle that catches it.** Table rows for the old holder's submissions in
  both windows, before and after the new dispatch. They are judged from
  stored rows, so the answer is the same either way; the property oracle is
  "claimed work never cancelled; the old holder refused from rows"
  (revision-control design.md, P-I2).
- **Source finding.** findings-60ea7371 (RC E).

### F1 — a terminal stop reentered before it is published (L12/O2)

- **Hazard.** A memoized terminal transaction is stored only after it fires
  its own callbacks (the `stopping` state publication, the teardown's turn
  settlement). A callback that calls kill or shutdown without awaiting it
  starts a second teardown. That teardown mints its own cancellation token.
  The first one's owned abort then reads as an independent failure, and the
  callers get different outcomes and modes.
- **Oracle that catches it.** The production session with the pinned SDK
  and the fake CLI. An external kill while a turn hangs, with a nested kill
  or shutdown from the interrupted turn result and from `onState('stopping')`,
  with and without an active turn. Assert one teardown in the first mode,
  one `stopped`, the same receipt or error object for every caller, and
  causes equal to only the callbacks' own throws
  (`packages/agent-runtime/__tests__/claudeReentrantStop.test.ts`). The
  omission control publishes the transaction late. Minting the token
  earlier on its own still leaves the duplicate teardown.
- **Source finding.** Adviser note b1298cf0 (task 4.1 F1, L12/O2).

### G1 — a waiting call cancelled only through a state the interrupt no longer has (L09/L10, R3 A4)

- **Hazard.** A send held on a pending checkpoint persistence notices an
  interrupt only through state the interrupt changes when a turn is active
  or starting (an epoch, the active turn). Once the turn that revealed the
  id has ended, the driver is idle. The interrupt then returns
  `no-active-turn`, and the held send runs after the persistence settles.
  The waiter's lifetime and the turn's lifetime are different; the tables
  had rows by state only, with no axis for a call that has not been
  acknowledged yet. A fix that sampled the epoch earlier closed the active
  trace and left both idle traces open.
- **Oracle that catches it.** The waiter table
  (`packages/agent-runtime/__tests__/oracles/interruptWaitersInputs.ts`):
  every driver state crossed with what the pending call waits for (nothing,
  start, persistence with `queue` or the default continuation). It adds a
  receipt row per waiter presence and after-interrupt rows for a late
  persistence resolution or rejection, newer sends, stop and reentrancy. It
  runs on the production session with a held onCheckpoint. The traces: a
  queued send held, then T0's result, then interrupt; and a default send
  made while idle and held, then interrupt. Each must refuse before the
  persistence is released.
- **Source finding.** Fresh advisory note 107f4892 (child task 26d717ca);
  lead decision R3 A4 on task 97d6bb7b.

### S1 — a resume answered with another conversation (R10/I2)

- **Hazard.** A resume is checked only where the runtime refuses it. A
  runtime that answers the resume with a fresh conversation instead (or
  with no identity) then has its first init adopted as an ordinary identity
  change. The new id is checkpointed, the turn succeeds in a conversation
  the caller never saved, and later sends are acknowledged against it. A
  start-time refusal check alone never sees this, because start succeeds.
- **Oracle that catches it.** Identity before effects: the first init of a
  resumed generation must name its target before any checkpoint, model,
  binding or turn effect. Rows on the production session over a controlled
  query (`packages/agent-runtime/__tests__/claudeResumeIdentity.test.ts`):
  the substituting runtime also answers the turn, so a missing guard shows
  as a success, not a hang. A real-SDK row with a nonconforming fake CLI
  (`claudeResume.test.ts`), and I2's seeded schedules in `substitute` mode
  (`resume.test.ts`). The omission control disables the identity check.
- **Source finding.** Lead binding note 60bfe634 (task 8eb64074, G1).

### T1 — a terminal decision published before it is owned (findings-6e7c50c8 F1)

- **Hazard.** A refusal publishes its callbacks (request cancellations, the
  error event) and only afterwards takes and settles the turns it ends. A
  stop or interrupt reentered from one of those callbacks takes the
  still-open turns first and overwrites the refusal's results
  (interrupted/stopped instead of failed/resume). Settling every taken turn
  through the opened-turn path also gives a queued turn that never opened a
  phantom `turn_completed`.
- **Oracle that catches it.** Decide before publishing: every affected
  turn's result is fixed, with no callback, before the first callback runs.
  Rows on the production session
  (`packages/agent-runtime/__tests__/claudeResumeIdentity.test.ts`):
  interrupt, shutdown or kill reentered from each publication of the
  refusal (`request_resolved` of a pending request, `error`,
  `turn_completed`, `onTurnResult`). Each row asserts both handles failed
  with resume, one `onTurnResult` each, and turn events only for the opened
  turn. Plus an unopened-queue ledger row. Run against the uncorrected
  sources, every one of these rows fails.
- **Source finding.** findings-6e7c50c8 F1 (task 8eb64074, P1 A3).

### T2 — a classification whose own state callback runs before the decision (L14)

- **Hazard.** T1's class, on the unexpected-exit path. The exit's
  classification sets `exited`, and its `onState` publication runs at once,
  before the turns are taken. Moving only the error event after the
  settlement leaves that earliest callback open. A stop or interrupt
  reentered from `onState('exited')`, a request cancellation or the error
  event replaces process-ended with interrupted/stopped. The queued turn
  that never opened also got a `turn_completed`.
- **Oracle that catches it.** Classification and decision in one held
  step, so `onState('exited')` is published only after every affected turn
  is decided. Rows on the production session
  (`packages/agent-runtime/__tests__/claudeExitOwnership.test.ts`): an
  active and a queued turn with a pending request, then the exit, with
  interrupt, shutdown or kill reentered from each publication (including
  `onState('exited')`). Plus a restart from `onState('exited')`, a read
  failure whose raw error stays owned, the idle exit and an earlier stop
  (L15). The order control publishes the classification before the hold;
  only the `onState` rows catch it.
- **Source finding.** Task 471 witness note 41fbeee9 (generationEnded
  observation from task 8eb64074).

## Test seams

### M1 — an oracle behind a hand-built harness (findings-6a6a844d)

- **Hazard.** The oracle passes inside a test-only composition while the
  production wiring never reaches the guarded seam, so the covered behavior
  is not what ships.
- **Oracle that catches it.** At least one oracle test per guarded seam runs
  through the production composition, and its mutant removes the wiring
  (`src/server/__tests__/restartSupersededSubmissions.test.ts` › "OG1:
  through the production composition the old holder's findings are refused
  restart-superseded and the new claimant's pass (kills M1)").
- **Source finding.** findings-6a6a844d.

### A scope wrapper tested only by direct calls (findings-f4b1ebad B1)

- **Hazard.** A wrapper that holds state still for one production read (a
  snapshot around a sweep) is tested by calling the wrapper directly, and
  nothing fails when the production read stops going through it. The same
  holds for read sites routed through a shared cache: a count taken at the
  cache never sees a caller that bypasses it.
- **Oracle that catches it.** A row per wrapper and per routed read site
  that drives the production composition and counts an observable effect
  of each resolution (here, reads of one catalog file), anchored to a fixed
  expected total; the control removes the wiring
  (`src/server/__tests__/sessionMailbox.test.ts` › "W1: the mailbox
  recipient sweep computes each catalog context's key once per sweep (kills
  R10)"; `src/server/__tests__/catalogMemoWiring.test.ts`, rows W2–W5). A
  path that stays uncached by design is counted in the exact total, never
  subtracted as an observed baseline.
- **Source finding.** findings-f4b1ebad B1–B3.

### An idempotence oracle observing only the uniquely constrained row (findings-d2f9140b F1)

- **Hazard.** A replay oracle checks only the row class a store constraint
  makes unique, so a dedup-guard bypass that first closes or replaces the
  surrounding live state still passes: `UNIQUE(source_key)` swallows the
  redelivered row while the extra closure rows and the state reset go unseen.
- **Oracle that catches it.** Snapshot every observation row and the persisted
  live state around the redelivery and require both snapshots identical, then
  close the original subject once and assert the closure's independently
  derived totals and open-entry outcomes
  (`src/server/__tests__/compactObservationTracker.test.ts` › "T1 E9: a
  redelivered turn start stores nothing and writes no ledger key"); the
  control bypasses the tracker's turn-start dedup guard only.
- **Source finding.** findings-d2f9140b F1 (compact-observation-detail).

### A per-file cleanup loop that stops at the first rejection or swallows it (task-98101592 F2)

- **Hazard.** A fixture's after-hook stops its drivers one by one with
  `await` in a loop, so the first stop that rejects skips every later driver.
  A sibling file instead catches every stop error, so a raw failure no test
  asserted disappears. Fixing one shared harness does not fix separate
  owners that roll their own loops.
- **Oracle that catches it.** Every fixture owner goes through one cleanup
  helper. The helper stores each stop before its effects and joins every
  driver whatever rejects. It then rethrows each unasserted original, and
  suppresses a failure only after an exact identity, order and count match.
  Regressions drive real drivers through that same helper
  (`packages/agent-runtime/__tests__/claudeCompatibilityCleanup.test.ts` ›
  "a first rejecting stop does not keep the after-hook from stopping the next
  driver; the original is rethrown", "two rejecting stops are both joined and
  rethrown together as their originals"). The controls restore the
  fail-fast loop and the swallow-all.
- **Source finding.** findings-6b5befb7 F2 (task-98101592), fixed in
  c5c67808.

## Cache keys

### A key input no fixture varies (findings-f4b1ebad B4)

- **Hazard.** A key part that only matters in some regimes — a default
  path whose file may exist, be missing, or be replaced by a user-level file
  — is held constant by every fixture, so deleting it from the key, or from
  a second raw key such as a snapshot's, survives every test.
- **Oracle that catches it.** One row per key input varied alone, in each
  regime: present with different content (value), missing, and replaced
  (key precision: distinct keys and resolutions of equal results), for every
  key that includes it (`src/server/__tests__/catalogMemo.test.ts`, rows
  K9a–K11d and N5a–N5f).
- **Source finding.** findings-f4b1ebad B4.

## Command surfaces

### Refusals missing the success envelope

- **Hazard.** A refusal path omits the envelope or headers every success
  carries, and a caller reads the difference as success, or crashes on the
  missing field.
- **Oracle that catches it.** A decision-table row for every refusal,
  asserting the same envelope and headers the success rows assert.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

## Path and identity checks

### A root swap escaping a listed-root check

- **Hazard.** Comparing a caller-supplied path against listed roots by
  prefix or unnormalized string lets a root swap — a symlink, a `..`
  segment, an alias — pass a membership check it should fail.
- **Oracle that catches it.** Compare lexically against the listed roots,
  after normalization, with a decision-table row per alias class.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

## Derived state

### Several readers disagreeing on derived state

- **Hazard.** Each stage re-derives the same state with its own logic, the
  readers drift apart, and one stage acts on a different answer to one
  question than the stage before it.
- **Oracle that catches it.** One function derives the state, and each stage
  gets its own table row over that shared derivation.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

### Retained state that aliases a view handed to a host callback (task-98101592 F1)

- **Hazard.** A mirror keeps the very object it passes to a host callback,
  as the retained reading for later use. A host that mutates its delivered
  view, or the correction it was given, then rewrites the facts a later step
  derives from: here the tokens a respawn re-anchors.
- **Oracle that catches it.** Through the production composition, the host
  mutates the delivered reading, and separately a delivered correction. A
  later respawn must still use the measured values
  (`src/server/__tests__/claudeCompatibilityContext.test.ts` › "a host
  mutation of a delivered reading cannot rewrite the tokens a respawn
  re-anchors", "a host mutation of a delivered correction cannot rewrite what
  the next respawn re-anchors"). The controls restore each alias.
- **Source finding.** findings-6b5befb7 F1 (task-98101592), fixed in
  e995fabc.

## Launch composition

### A registered name frozen at creation

- **Hazard.** A launch seam derives the registered-name set once — at
  session creation or driver construction — and reuses it, so a name that
  registers later reaches the spawned or respawned child.
- **Oracle that catches it.** The set is re-derived at every spawn through
  a provider holding the persistence store, and a manager-level test
  registers a name after the driver exists and asserts the respawned
  child's environment (`src/server/__tests__/registeredNamesManagerWiring.test.ts`
  › "a respawn re-derives the set and keeps removed entries withheld
  (M-freeze, M1a)").
- **Source finding.** Advisories note-da7f0861 + note-0f4155a0 (correction
  A of provider-relay-setup).

### A branch re-composing a name it filtered

- **Hazard.** A launch branch filters registered names from its catalog
  entries but then composes its own neutralization — a controlled settings
  map, route pins, credential blanks, or the Codex home — re-introducing a
  registered name under its own key; dropping the key instead silently
  weakens the protection the branch exists to provide.
- **Oracle that catches it.** A typed pre-spawn refusal on every composing
  branch (credentialed pins+blanks+controlled, named-profile controlled,
  Codex home), asserted per row at the resolve, driver, and manager seams
  with a hostile settings file on disk, zero launches, and a settled
  failed send (`src/server/__tests__/registeredNamesRefusals.test.ts`,
  `src/server/__tests__/registeredNamesRefusalWiring.test.ts`).
- **Source finding.** The Lead's rev 5.1 conformance disposition
  (note-f6467fdb; correction B of provider-relay-setup).

## Protocol projections

### An accept that carries no validated content (task e522, note-56b4bb9f)

- **Hazard.** A protocol request whose acceptance needs structured content
  (a Codex `form`, `openai/form` or `openaiForm` elicitation with a
  `requestedSchema`) is projected onto an allow/deny answer. The allow then
  sends `accept` with empty content, despite a required field, and a
  content-free mode (`url`, `openai/userVerification`) sends `{}` where the
  protocol binds `null`. Declining every form instead leaves the capability
  silently disabled.
- **Oracle that catches it.** Through the public driver and the owned fake
  app-server, read the reply the app-server actually received. Per form
  alias: typed JSON validated against the captured schema accepts with
  exactly that content once; invalid JSON, a wrong type, a missing required
  field, a non-member enum value, a wrong nested field and an impossible
  calendar date are refused and stay pending; Decline
  and Cancel reply their actions; a schema the codec cannot validate is
  declined and its exact shape reported once. Per content-free mode: allow
  replies `content: null`
  (`packages/agent-runtime/__tests__/codexElicitation.test.ts`,
  `codexRequests.test.ts`).
- **Source finding.** note-56b4bb9f (task e522 path assessment).

## Transport and liveness

### A mutant masked by a required fallback (note-7bb8add0 F1)

- **Hazard.** A wiring oracle names a single-flag mutant (Bun's
  `closeOnBackpressureLimit` left `false`) while the same design requires
  an independent fallback (the hub closes on a `0` send status) that
  produces the same observable outcome, so the end-to-end test passes with
  its mutant, or a test written to fail it rejects the required fallback.
- **Oracle that catches it.** Each redundant mechanism is killed at its
  own boundary, and the end-to-end oracle's mutant removes all of them
  together: fast-chat-switching design.md B1 (the production options), B3
  (a fake socket returning `0`), and OW5 (both removed: a sequence gap on
  an open socket).
- **Source finding.** note-7bb8add0 F1 (fast-chat-switching D5 spec
  advisory, task-d86465fe R1).

### A timing oracle with an unpinned fixture (note-7bb8add0 F2)

- **Hazard.** A browser-level liveness oracle requires a mutant to time
  out, but leaves payload entropy, part layout, compression, and the
  effective link rate free, so a compressible or per-part fixture lets the
  mutant's transfer finish before the heartbeat and the oracle is vacuous.
- **Oracle that catches it.** Pin the transfer conditions and observe
  them: a pacing proxy with a measured-rate assertion, compression off,
  incompressible outputs in a pinned turn layout, and a selection time that
  makes the mutant's transfer overlap the ping and outlast its deadline;
  payload assertions are kept separate from timing assertions
  (fast-chat-switching design.md OW6).
- **Source finding.** note-7bb8add0 F2 (fast-chat-switching D5 spec
  advisory, task-d86465fe R1).

### An unbounded recovery reply under a whole-message heartbeat (note-7bb8add0 F3)

- **Hazard.** A design bounds every pushed message to protect the
  heartbeat, then adds an on-demand fetch over the same socket. The
  browser reports only whole messages, so any reply larger than the link
  carries within the deadline delays the pong and the healthy socket is
  replaced. A bound counted in decoded bytes hides it: JSON escaping can
  grow a 64 KiB chunk sixfold (U+0001 serializes as six bytes), and the
  1.5 s resume check is stricter than the 10 s heartbeat. A
  handler-level oracle never sees the transport.
- **Oracle that catches it.** The large payload leaves the socket: the
  full output comes from an HTTP route, the preview and each live batch
  are capped on their serialized, as-sent size, and the cap's rows
  include escape-heavy text (fast-chat-switching design.md D5a, D5d, D5e;
  rows E7, E10, E15, E16). A transport oracle hides and shows the page
  during the HTTP download on a throttled link with pinned pacing and
  measured bounds, and kills the 5f design of 64 KiB decoded WebSocket
  chunks of U+0001 text under the early resume (OW6).
- **Source finding.** note-7bb8add0 F3 (fast-chat-switching D5 spec
  advisory, task-d86465fe R1); the escaping counterexample, note-60893e96.

### A wiring mutant the framework absorbs (note-8716978d N1)

- **Hazard.** An end-to-end oracle names a route-order mutant (the route
  mounted after the static fallback) and expects a wrong reply, but the
  static middleware calls `next()` when no file matches, so the route
  still answers and the mutant survives; a test asserting the wrong reply
  would fail on correct code.
- **Oracle that catches it.** Mutate the wiring itself: the route not
  mounted, or mounted at another path, so the real app's status, type,
  and body observation fails; keep mounting order as a requirement
  without claiming it as a mutant, and never change working middleware to
  make a mutant harmful (fast-chat-switching design.md OW4).
- **Source finding.** note-8716978d N1 (fast-chat-switching D5 spec
  advisory, task-d86465fe R4).

### A fixture gate that depends on the product (note-8716978d N2)

- **Hazard.** A timing oracle treats an end-to-end product latency (the
  app's own `pong` within 1,200 ms) as a fixture-validity bound and
  withholds the product verdict when it breaks, so the required mutant,
  whose failure is exactly that latency, is reported as a fixture gap and
  never fails; a resume trigger tied to one transport's event never fires
  for a mutant on the other transport.
- **Oracle that catches it.** Qualify the fixture only from the proxy's
  own ingress and egress record and a test-owned calibration control,
  report fixture gaps and product failures as separate classes, and
  trigger the resume from the target payload's first byte on whichever
  transport carries it, ending the run on the mutant's timeout instead of
  waiting for an absent event (fast-chat-switching design.md OW6).
- **Source finding.** note-8716978d N2 (fast-chat-switching D5 spec
  advisory, task-d86465fe R4).

### EOF before exit, and job context in stream listeners (task 311)

- **Hazard.** A transport rejects its pending requests at stdout EOF and
  names the end from the exit it has seen so far; the child's `exit` event
  can follow EOF, so the reason reads "closed its output" for a process
  that exited with a code. Separately, a reader started inside an owned
  job registers its stream listeners there, and the listeners inherit that
  async context: a notification observer's stop is then classified as a
  job's own stop and refused.
- **Oracle that catches it.** Assert the exact rejection message of a
  pending request when the real child exits with a code and stderr, and
  call stop from a real notification observer, expecting the shared
  terminal receipt rather than `internal` (codexTransport.test.ts,
  codexTransportStop.test.ts).
- **Source finding.** task-3110e52b first fake-app-server run: both rows
  failed before the end was keyed on exit and EOF together and observers
  ran outside the job context.

### A memoized stop assigned after its synchronous teardown (task 311 PC1/PC2)

- **Hazard.** `terminal ??= terminate()` assigns the shared promise only
  after terminate's synchronous prefix returns; that prefix aborts handler
  signals, so an abort listener calling stop finds no terminal yet and
  starts a second teardown. In the same stop, a reader that resolves on any
  error once closing began treats an independent stream failure as the
  stop's own cancellation and drops it.
- **Oracle that catches it.** Stop from a real handler's abort listener and
  assert the nested promise is the outer one (identity, captured before the
  handler is released); emit a raw error on the real stdout after stop began
  and assert the stop rejects with it by identity (codexTransportStop.test.ts).
- **Source finding.** task-3110e52b path assessment (disposition 3e7d024d);
  both rows failed on 17b9d294 before the terminal was reserved first and
  the reader kept every error.


### An observer that reenters before its frame is decided (task 73 PC1/PC2)

- **Hazard.** A frame's own observation runs before the state that frame
  decides. The Claude result frame's context usage was observed before its
  result was decided, so an interrupt from `onContextUsage` settled the
  turn `interrupted` and replaced the provider's success. A limit retry's
  `failure` observer ran before its wait was registered, so an interrupt
  from it ended the turn with no wait, and the wait registered afterwards
  was orphaned. Only a later stop's `endAll` ended it, which hides it from
  any assertion made after the stop.
- **Oracle that catches it.** Interrupt from the observer itself through
  the real fake CLI and app-server. Assert the result is the provider's
  success. For the wait, assert `failure`, `wait-start` and then one
  `wait-end` with the same `waitId` and cause `cancelled`, captured before
  any stop (claudeUsageFacts.test.ts PC1/PC2, codexUsageFacts.test.ts).
  Run the controls on that pre-stop snapshot.
- **Source finding.** task-73ecea50 Lead path review 639cc35a of fbd90661.
  The fix is in cd0adadd: a result is decided before its frame's
  observations, a wait is registered before any limit observer, and limit
  events are published in order.

### A decided frame's observer acting on the queued successor (task 73 FRESH-A/B)

- **Hazard.** Deciding a terminal result before its observers run is not
  enough when a successor exists. The Claude result promoted the queued
  turn B before the first turn's own context observation ran, so an
  interrupt from that `onContextUsage` interrupted B instead. In the same
  review, a stale lower Codex token total was discarded for usage but still
  ended a limit wait as `resumed`: a progress rule keyed on the method name
  rather than on accepted new work.
- **Oracle that catches it.** Queue a successor behind the observed turn on
  the default composition. Interrupt from each of the first frame's
  publications and observations (`onTurnResult`, `onContextUsage`, a failed
  turn's `error` event, and a send from the same callback). Assert the
  successor's provider outcome, no successor `turn_started` before the
  observation, and the interrupt's `no-active-turn` receipt
  (oldFrame.test.ts). For waits, follow a stale and an equal repeated total
  with a non-progress sentinel (a quota push), and assert the wait is still
  open (codexUsageFacts.test.ts). A reference model that counts any update
  as progress hides this, so the model states it too (usageModels.ts).
- **Source finding.** task-73ecea50 fresh assessment e50cba22
  (note-ba5046e5), disposition a546aea5. INV-A2 is note-7f2b3062.

### An in-memory stdio fake that answers inside the writer's own write (task 73, private seam)

- **Hazard.** A `PassThrough` in flowing mode emits `data` synchronously
  inside `write()`. A fake app-server served over two of them therefore
  handled `turn/start`, and the transport read its reply and every
  notification, all inside the transport's own write. That happened before
  the session's send had opened the turn. No pipe can deliver like that.
  Deltas landed before `turn_started` and every turn hung. A campaign built
  on such a fake tests a reentrancy the product never meets, and it can
  hide the delivery the product does meet.
- **Oracle that catches it.** Before running a campaign on a replaced
  process, run one short script through both the owned process and the
  in-process owner and compare the event order and outcomes. The seam
  delivers each direction on a later task and coalesces the lines of one
  task into one chunk, as a pipe can (helpers/inProcessCodex.ts). Each
  guard keeps a witness on the owned process. The binding mutants
  (M-bind-completed, M-bind-foreign) must fail on that witness too
  (codexTurnStreams.test.ts), not only in the in-process campaign.
  For the I2 resume sequences, the readiness control (start not awaiting
  the checkpoint report) must fail generated sequences and the
  owned-process witness sequences as named log differences, not timeouts.
- **Source finding.** task-73ecea50, Lead decision note-e5492858 (bulk
  campaigns over a private seam); I2 under task R2, note-d9bcb84a.

### A latest-request pointer used as the request owner (task 73 F3)

- **Hazard.** Claude names each main-thread request by its native message
  id, and a frame of an earlier request can arrive again later: a replayed
  message_start or assistant snapshot, or a message_delta after one. The
  first correction kept only the latest request and its owner. A turn whose
  own request had intervened then took the earlier turn's replayed request
  as its own, because the ids differed, and reported the old tokens and
  cache counts as its measurements.
- **Oracle that catches it.** Own requests by native id, apart from the
  context cursor. The reference model keeps every id's first owner
  (usageModels.ts) and the I7 generator replays seen ids in their own turn
  and in later ones, after a request of the replaying turn
  (usage:partial-after-earlier-turn-replay). A model that only remembers
  the last request passes the adjacent case and misses this one. The public
  owned-CLI tests replay an earlier turn's request after the next turn's own
  one, as a snapshot, as a message_start, with a later delta and after a
  conversation reset (claudeUsageFacts.test.ts).
- **Second miss (findings-040f141e).** The registry admitted an id only
  when its frame carried counters, and the wait resumed on any main-thread
  frame. A counter-less first sighting left the id free for a later turn,
  and a replayed or duplicate frame ended a limit wait. Admission is now
  one mandatory identity step, counters an optional overlay, and a wait
  resumes only on a novel phase of the live turn's own source. The model
  starts requests without counters (request-without-counters) and marks a
  replay inside a wait that must not resume it (replay-in-wait-unresumed).
  Each frame's facts and wait are decided before any observer runs.
- **Third miss (findings-14bde0ed).** The content identity kept only each
  block's type, id and text, so two thinking snapshots of one request looked
  equal and new thinking after a retry did not resume the wait. The identity
  now covers each supported block's progress-bearing fields (thinking with
  its signature, redacted data, tool name and input) in an unambiguous
  encoding. The generator grows the block kind a request already streamed,
  and the model marks content that differs only in thinking
  (thinking-only-content-resumes-wait); a type/id/text projection fails it.
- **Source finding.** task-73ecea50 findings-55a68ce4 (F3), creator
  note-229f71ee; findings-040f141e (F3/A2, F5/A3); findings-14bde0ed (F5).
