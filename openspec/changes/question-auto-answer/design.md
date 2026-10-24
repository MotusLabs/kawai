# Design

## Context

Prerequisite: `fix/question-other-answer` makes a single-select answer one
choice (an option or the user's own text; both refused) and appends own text
to multi-select selections. The modified "Agent questions collect structured
user answers" requirement records that behavior; this change relies on it
because the recommended answer it sends is an ordinary option answer.

`AskUserQuestion` reaches kawai through the SDK `canUseTool` callback.
`ChatSessionDriver.canUseTool` parses the input with `parseQuestions`
(`contentBlocks.ts`), stores a `PendingRequest` of kind `question`, emits
`question_request`, and waits on a promise that `answerQuestion` (user),
`cancelRequest` (abort, interrupt, kill), or nothing settles. The approval
policy is read per request through the `getApprovalPolicy` driver option that
`ChatSessionManager` supplies, and policy grants are emitted as
`request_resolved` with `decidedBy: 'policy'`. Pending requests are in-memory
only and are cancelled by a server restart. Server-persisted settings live in
`app_settings` behind `/api/settings/*` (`src/server/routes/settings.ts`).

Claude Code's `AskUserQuestion` tool asks the model to put its recommendation
first with the label suffix `(Recommended)`; that suffix is the only
recommendation signal in the input.

## Goals / Non-Goals

**Goals:**
- The deadline is enforced by the server, so it fires with no browser open —
  the case that matters for spawned team members.
- One settlement path: an automatic answer goes through the same validation
  and resolution as a user answer, so first-answer-wins, status refresh, and
  client removal behave identically.

**Non-Goals:**
- Per-session or per-group waits (one global setting; can be added later).
- Restoring deadlines or pending questions across a server restart.
- Guessing a recommendation for questions that do not mark one, or answering
  approval cards on a timeout.
- Free-text answers produced by kawai.

## Decisions

**D1 — Recommendation detection is a pure function beside `parseQuestions`.**
`recommendedAnswers(questions): Record<string, ChatQuestionAnswer> | null`
returns null unless every question has at least one label matching
`/\(recommended\)\s*$/i`; single-select takes the first match, multi-select
every match. Labels are returned verbatim so `validateAnswers` accepts them.
Alternative — treat the first option as recommended when none is marked:
rejected, the tool convention makes "first" a style hint, not a decision.

**D2 — The driver owns the timer.** A new driver option
`getQuestionAutoAnswerMs?: () => number` (0 = off) is read once when the
question is created, alongside the policy. When D1 yields answers and the
wait is positive, the pending request gets `autoAnswerAt` (ISO) and a
`setTimeout` handle; `question_request` carries
`autoAnswer: { at, answers }` so clients can show what will be chosen. Every
settlement path (`answerQuestion`, `cancelRequest`, kill/shutdown, the timer
itself) clears the handle. The timer calls a private settle that reuses
`validateAnswers` and emits `request_resolved` with `outcome: 'answered'`,
`decidedBy: 'timeout'`, and the chosen labels in a new optional `answers`
field for the transcript. Alternative — a manager-level sweeper over all
sessions: rejected, it duplicates the pending map the driver already owns and
needs its own cancellation bookkeeping.

**D3 — The note to the agent rides the tool input.** Automatic settlement
returns `updatedInput` with the recommended `answers` plus
`response: "No answer from the user within N minutes; the recommended option
was selected automatically."` The CLI folds `response` into the tool result,
so the agent sees it and transcript replay (which rebuilds history from the
CLI transcript after restart) shows it in the tool result even though the
`request_resolved` marker is live-only, like policy grants today.

**D4 — Hold is a client message and a sequenced event.** `chat-question-hold
{ sessionId, requestId }` (added to `CHAT_CONNECTION_TYPES`) calls
`driver.holdQuestion(requestId)`: refused when the request is not a pending
question with a deadline; otherwise clears the timer, drops `autoAnswerAt`,
and emits `question_auto_answer_held { requestId }`. Clients drop the
countdown on that event; `getPendingRequests` returns `autoAnswer` only while
a deadline stands, so late attachers agree. Holding again or answering after
a hold behaves as an ordinary pending question. The form sends the same hold
on its first edit (an option chosen or text typed) while a deadline stands,
so an unsubmitted answer is never overridden; this uses the explicit message
rather than implicit server inference, so server state stays the single truth.

**D5 — The setting is one `app_settings` key.** `question_auto_answer_minutes`,
integer 0–1440, default 5, read at boot into the manager and updated through a
`PUT /api/settings/question-auto-answer` route with the same
persist-then-apply rollback the other settings use; the change is broadcast so
open Settings dialogs update. The manager's getter converts to milliseconds.
Alternative — a client-side setting sent per session like
`defaultApprovalPolicy`: rejected, the timer runs on the server and must
apply to spawned sessions no browser created.

**D6 — Client rendering.** `ChatRequests.tsx` shows, under the form, "Will
choose <labels> in m:ss" ticking from `autoAnswer.at` on the client clock and
a **Wait for me** button (disabled while disconnected); `ChatMessages.tsx`
renders `decidedBy: 'timeout'` as "Answered automatically: <labels>" and the
held event as "Auto-answer held". `SettingsModal.tsx` gains a minutes field
with inline refusal.

**D7 — New shared contracts go in a new shared module.** The `autoAnswer`
payload, the `'timeout'` decided-by value, the resolved answer labels, and
the `question_auto_answer_held` event are defined in a new module beside
`src/shared/chat.ts`, which re-exports them for existing importers: `chat.ts`
is already 578 lines, and this change adds four public shapes to it.
Alternative — extend `chat.ts` in place: rejected, the file is past the size
where another append is free.

## Acceptance oracles

The pending question is a small state machine (pending → settled or held)
without recovery: a deadline is in-memory only, and a restart cancels every
pending question without restoring it, so nothing survives to re-converge.
These oracles are the change's acceptance surface. Every row id (`QA-*`) is
cited by a `tasks.md` Verify bullet and each Verify bullet names the mutant
its tests must kill; a preserved-behavior task with no row of its own (1.0)
cites the named spec scenario it guards.

### Decision tables

Table 1 — one pending question, from creation to its first settlement or
hold. "all marked" = every question of the request has a recommended
option; `decidedBy` is the resolution's decided-by value; "autoAnswer
shown" is whether `question_request` and `getPendingRequests` carry
`autoAnswer`.

| Oracle id | Marking | Wait | First event | decidedBy | autoAnswer shown | Events after | Status after |
|---|---|---|---|---|---|---|---|
| QA-1 | all marked | positive | the deadline fires | `timeout` | yes | `request_resolved { outcome: 'answered', decidedBy: 'timeout', answers }` plus the D3 note to the agent | leaves `permission`, the agent continues |
| QA-2 | all marked | positive | the user answers | `user` | yes | `request_resolved { outcome: 'answered', decidedBy: 'user' }` | leaves `permission`; the timer is cleared, no later settlement |
| QA-3 | all marked | positive | Wait for me | none | dropped on the held event | `question_auto_answer_held { requestId }` | still `permission`, waits for the user |
| QA-4 | all marked | positive | the first form edit (option or text, unsubmitted) | none | dropped on the held event | `question_auto_answer_held { requestId }` | still `permission`, waits for the user |
| QA-5 | all marked | positive | cancel or interrupt | none | yes, until the cancellation | the request's ordinary cancellation resolution | as a cancelled approval today |
| QA-6 | all marked | positive | kill | none | yes, until the kill | the cancellation resolution (see the cancellation note), then the agent process ends | the kill path as today |
| QA-7 | all marked | positive | server restart | none | yes, until the restart | the cancellation resolution (an orderly shutdown settles like a kill); no deadline restored | as today |
| QA-8 | * | * | the user answers | `user` | no | `request_resolved { outcome: 'answered', decidedBy: 'user' }` | leaves `permission` |
| QA-9 | * | * | cancel or interrupt | none | no | the ordinary cancellation resolution | as a cancelled approval today |
| QA-10 | * | * | kill | none | no | the cancellation resolution, then the process ends | the kill path as today |
| QA-11 | * | * | server restart | none | no | the cancellation resolution; no deadline restored | the restart path as today |
| QA-27 | * | * | the first form edit | none | no | none — the form sends no hold without a deadline; the edit is an ordinary unsubmitted answer | still `permission`, pending |

Rows QA-8…QA-11 and QA-27 carry `*` for marking and wait: the three
combinations that set no deadline — all marked with a zero wait, one
unmarked with a positive wait, one unmarked with a zero wait — behave
identically from there; QA-P3 pins which combinations those are.

Cancellation note (QA-5, QA-6, QA-7, QA-9, QA-10, QA-11): every teardown
path settles a pending request with the ordinary
`request_resolved { outcome: 'cancelled' }` resolution before the process
goes — interrupt (`ChatSessionDriver.ts:531`), kill (`:563`), an orderly
server shutdown (`:587–589`, shutdown() calls kill(); `ChatSessionManager.ts:2201`
and `:2252` route both) and an agent-process crash (`:938`) — through the
emit at `:1515`. The timer is cleared with the request and no automatic
answer is recorded. Only a whole-server crash emits nothing (no code runs);
nothing is restored on the next boot.

Table 2 — a later event on a request that is no longer deadline-bearing.
State is how it left the pending-with-deadline state; kill and restart
admit no later event on the request itself (QA-U5).

| Oracle id | State | Later event | Observable result |
|---|---|---|---|
| QA-12 | answered by the timeout, or by the user | a second user answer | refused as stale like any late answer; no second resolution |
| QA-13 | answered by the timeout | Wait for me | refused — not a pending question; nothing changes |
| QA-14 | answered by the timeout, or by the user | the first form edit | nothing — no deadline stands; the edit is an ordinary unsubmitted answer |
| QA-15 | answered by the user | the original deadline passes | nothing — the timer was cleared at settlement; no second resolution |
| QA-16 | answered by the user | Wait for me | refused — not a pending question; nothing changes |
| QA-17 | answered by the timeout | restart, then replay | the automatic answer reaches replayed history through the tool result's note (D3), never as a live marker |
| QA-18 | answered by the user | restart, then replay | the answer replays as today |
| QA-19 | cancelled | the user answers or Wait for me | refused as stale like any late answer |
| QA-20 | cancelled | the original deadline passes | nothing — the timer was cleared at cancellation |
| QA-21 | held | the original deadline passes | nothing — the timer was cleared at the hold; the request stays pending |
| QA-22 | held | the user answers | an ordinary user settlement |
| QA-23 | held | Wait for me or the first form edit | refused / inert — no deadline stands (D4 refuses a deadline-less request; the form sends a hold only while one stands) |
| QA-24 | held | restart, then replay | the pending question is cancelled by the restart like any other; nothing auto-answers |
| QA-25 | cancelled | the first form edit | nothing — the request is settled; a racing client's edit is inert |
| QA-26 | cancelled | restart, then replay | the cancellation replays as today |

For the timeout state, "the original deadline passes" is the settlement
row QA-1 itself — the deadline that passes is the settlement, and the
timer is not re-armed.

Table 3 — the saved wait value, a partition of the value axis:

| Oracle id | Saved value | Observable result |
|---|---|---|
| QA-S1 | never saved | the default 5 minutes applies (the spec's default scenario) |
| QA-S2 | 0, a whole number in range | automatic answers off — no deadline is ever set afterwards (the QA-8…QA-11 class) |
| QA-S3 | a whole number 1–1440 | that wait applies to questions asked after the save |
| QA-S4 | any value outside 0–1440 or not a whole number (1441, -1, 2.5, 1442, 1.5, …) | refused with an error; nothing is stored and nothing changes |

Table 4 — a save against a pending deadline, one orthogonal invariant
rather than a fifth value row: a save matches exactly one of QA-S1…QA-S4
and, when a question with a deadline is pending, also QA-S5.

| Oracle id | Input | Observable result |
|---|---|---|
| QA-S5 | any valid save (0–1440) that commits while a question with a deadline is pending | that pending deadline keeps its original time (QA-P4; the spec's change scenario) |

Unreachable combinations:

- **QA-U1** — a deadline fires when the wait is 0 or a question is
  unmarked: no timer exists (QA-P3).
- **QA-U2** — a hold taking effect on a request without a deadline:
  `holdQuestion` refuses a deadline-less request (D4), and the form sends a
  hold only while one stands. The ordinary first edit without a deadline is
  reachable — QA-27, not an unreachable cell.
- **QA-U3** — two settlements of one request in any order: every
  settlement path clears the timer first (D2); the second attempt is
  refused or inert (QA-12…QA-16, QA-19…QA-21).
- **QA-U4** — a deadline on a Codex chat's question: deadlines are
  created only in Claude chat sessions (the spec's Codex scenario).
- **QA-U5** — a later event on the request after kill or restart: the
  request no longer exists; only the replay rows (QA-17, QA-18, QA-24,
  QA-26) observe anything.

### Properties

All four run as plain seeded generators over the seams named here — no new
dependency. Fixed seed 20261024 for every property. The seams: the driver's
injectable timer scheduler (D2's `setTimeout`/`clearTimeout` behind a seam
the tests advance by hand), the public `answerQuestion`/`cancelRequest`/
`holdQuestion` entry points, the pure `recommendedAnswers`, and the
manager's setting getter.

- **QA-P1 — settled exactly once under any interleaving.** For any
  interleaving of settlement attempts — user answer, Wait for me,
  form-edit hold, cancel, timer fire, including duplicates and same-tick
  arrivals — the request emits at most one resolution, its `decidedBy` is
  the first settling attempt's, and every later attempt is refused or
  inert. Generator: seeded shuffles of attempt sequences of length 1–5
  over the five attempts, each sequence also run once with every attempt
  on the same fake tick. 500 cases.
- **QA-P2 — a held question never auto-answers.** After a hold at any
  instant of the wait window — the first tick after creation through the
  last tick before the deadline — advancing the clock arbitrarily far
  never settles the request, and `getPendingRequests` stops carrying
  `autoAnswer`. Generator: hold time uniform over [0, wait) — same-tick
  arrivals at the deadline itself are QA-P1's sequences, and a hold
  refused at an already-settled request is QA-13's row — then an advance
  of wait × k for k ∈ {1, 10, 1000}. 200 cases.
- **QA-P3 — no deadline without a full recommendation.** A deadline
  (`autoAnswerAt` and a live timer) exists if and only if
  `recommendedAnswers` returned answers and the wait was positive.
  Generator: question sets over count 1–3 × single/multi-select × 0–4
  options per question × marker variants (trailing marked, mid-label
  marker, case and whitespace variants, absent) × wait {0, positive}.
  300 cases.
- **QA-P4 — a setting change never moves a pending deadline.** Changing
  the saved wait at any instant between a question's creation and its
  deadline leaves that request's `autoAnswerAt` and firing time unchanged;
  only questions created after the change read the new value. Generator:
  (initial wait, new wait, change instant) triples, waits from
  {0, 1, 5, 1440} minutes, the change uniform over the wait window.
  200 cases.

### Completeness

Every combination of the axes matches exactly one row or one unreachable
claim. Marking {all marked, one unmarked} × wait {0, positive} × first
event {the deadline, the user answers, Wait for me, the first form edit,
cancel/interrupt, kill, restart} is 28 cells: 7 deadline-bearing rows
(QA-1…QA-7) and, per no-deadline combination, 5 reachable rows (QA-8…QA-11
and QA-27 carry the three combinations each with `*`) and 2 unreachable
claims (QA-U1, QA-U2) — 15 reachable plus 6 unreachable cells. State
{answered by the timeout, answered by the user, cancelled, held} × later
event {a second user answer, Wait for me, the first form edit, the
original deadline passes, restart then replay} is 20 cells, all covered by
QA-12…QA-26 (QA-12 and QA-14 name two states each; the timeout state's
deadline cell is QA-1). The saved value is partitioned by QA-S1…QA-S4
(QA-S4 is the whole invalid class); QA-S5 is the orthogonal
pending-deadline invariant, matched additionally by any save that commits
while a deadline stands. No gap, no overlap.

### Model-based tests

Not required: no deadline survives a restart (QA-7, QA-24) — the state
machine has no recovery axis, so there is no resumed state for a
model-based run to re-converge and no crash boundary to replay. The blind
second reading required for state machines with recovery does not apply;
the Lead may still opt in.

### Hazard notes

Consulted `docs/oracle-hazards.md`: **M1** — at least one test per guarded
seam runs through the production composition (a driver constructed by
`ChatSessionManager`), and the wiring mutants (M-2.1, M-3.2) are killed
only there (tasks 3.2 and 5.2); **several readers disagreeing on derived
state** — `recommendedAnswers` is the one derivation of "recommended", and
both the deadline decision and the shown `autoAnswer` read it; **refusals
missing the success envelope** — QA-13, QA-16, QA-19, and QA-23 assert the
same error envelope the success paths emit.

## Risks / Trade-offs

- [The human is mid-way through the form when the deadline fires] → the
  first edit sends a hold (D4); only a human who has not touched the form can
  be overridden. A hold racing the timer loses only if the timer already
  settled, and then the hold is refused as stale like any late answer.
- [Client and server clocks differ] → the countdown is display only; the
  server timer decides. A skewed client may show 0:00 briefly before the
  resolution arrives.
- [A recommended option the human would have rejected gets acted on] → the
  agent is told the answer was automatic (D3); setting 0 disables the feature.
- [Restart drops pending questions anyway] → unchanged behavior; no deadline
  persistence is attempted.

## Migration Plan

No schema change: a missing `app_settings` key reads as the 5-minute
default. Existing sessions pick it up on their next question. Rollback is
removing the code; the stored key is then ignored.
