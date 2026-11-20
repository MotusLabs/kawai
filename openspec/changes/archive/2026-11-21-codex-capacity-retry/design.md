# Design

## Context

See proposal.md for motivation. Retargeted 2026-11-18 (proposed) onto the extracted runtime package; the 2026-10-26 context named `CodexSessionDriver.ts`, which no longer exists.

### Current inventory (source pin `f52963d0`)

Nothing of this change is implemented (all ten tasks open).

- **Classification.** `packages/agent-runtime/src/usage/limits.ts:107-111`: `codexLimitScope` maps `serverOverloaded` to `login`, so `codexLimitFailure` reports it as a limit failure; `src/server/__tests__/codexLimits.test.ts:119` pins that. `packages/agent-runtime/src/codex/auth.ts:68` maps it to the error category `rate-limit`, which no Kawai code reads. Kawai's `src/server/chat/codex/codexLimits.ts` only attributes a recorded kind to the Codex home's provider through `codexLimitScope`.
- **Turn completion.** `packages/agent-runtime/src/codex/session.ts:365-381` (`turnCompleted`): a failed turn decides its result, runs `facts.finalLimit` (`codex/facts.ts:164`), publishes, and emits `error`. Every failed attempt therefore ends the logical turn, and a capacity failure becomes a final login-scoped limit event.
- **Upstream retries.** `codex/facts.ts:125` treats a `willRetry` error notification of a limit kind as a non-final failure and starts a limit wait; `codex/activity.ts:54` shows it as a fixed `{ attempt: 1, maxRetries: 1 }` retry.
- **Turn identity.** `codex/turns.ts` binds the native turn id from the `turn/start` reply or `turn/started`; an interrupt waits for the binding (`interruptOwed`, `session.ts:566-574`). `session.ts:485` sends `turn/start`.
- **Kawai adapter.** `src/server/chat/provider/codexRuntimeSupport.ts:114-122` forwards `onActivity` and maps `onLimitEvent` through `chatLimitSignal` (`runtimeEvents.ts:82`); `ChatSessionManager.ts:2932-2943` records the event with `codexLimitProviderId`, which feeds `LimitOutcomes` (`src/server/team/routing/limitOutcomes.ts`). Urgent direct mail interrupts a busy recipient through the dispatcher (`src/server/team/dispatcher.ts`, `push(…, interrupt)` at :468-482).
- **Activity.** `src/shared/chat.ts:335-347` `ChatActivity` has `attempt`, `maxRetries`, and `errorStatus` for `retrying`; the package's `ChatActivityState.retry` (`common/activity.ts:31`) the same.
- **Replay.** `src/server/chat/codex/codexRollout.ts` parses rollout `response_item` user messages into `user_message` or `peer_message` (:124-130), so a continuation input would read as human input.
- **Sizes.** `codex/session.ts` is 628 lines and `src/server/chat/provider/codexRuntime.ts` 571, both over the 500-line bound already; `ChatSessionManager.ts` is 3,923. This change must not grow them: new logic goes in new modules, and the hooks in these files replace lines rather than add net lines.
- **Package boundary.** Kawai depends on `workspace:0.1.1`, and the root runner includes `packages/*/__tests__/*.test.ts` (`8692da13`), so package edits reach Kawai and its checks with no publication. Nothing in revision-control or any other open change is a prerequisite.

The durable `profile-limit-handling` requirements currently include overload in quota events. The two modified requirement blocks carve out Codex capacity errors; they match the current main text otherwise (checked 2026-11-18). Other providers' overload handling and actual Codex quota handling remain as specified.

## Goals / Non-Goals

**Goals:** Keep the existing driver/manager lifecycle and mailbox ownership intact through capacity retries; make timing deterministic under tests; prevent stale work after cancellation; keep token accounting across attempts correct.

**Non-Goals:** Model switching, provider switching, generic retries of every error or RPC rejection, persisted retry jobs, changes to Claude retry policy, or a settings UI. The application can prevent its own tool-call replay; it cannot guarantee an agent never independently chooses to repeat an operation.

## Decisions

### D1: Separate capacity from quota at the structured error boundary

Recognize only a failed matching Codex attempt whose `error.codexErrorInfo` is exactly `serverOverloaded`. In a session with `capacityRecovery: 'bounded'` (D2), the session's limit facts skip that kind, so neither upstream retry notifications nor terminal capacity attempts emit quota signals there. The exported `codexLimitScope` is unchanged (it still maps `serverOverloaded` to `login`, and `codexLimits.test.ts:119` stays), and a session with the option omitted or `'off'` keeps today's overload limit events, upstream and terminal (table O). Exhaustion ends as an ordinary capacity error, never a fabricated quota event. Cached exhausted quota windows do not supply a capacity deadline. A later real quota failure follows the existing quota path unchanged.

Alternative: keep recording final overload limit events and override cooldown duration. Rejected because the same events also drive parking and forwarding and imply account exhaustion. Retain existing historical events without rewriting the append-only record; already-recorded cooldowns expire normally.

### D2: Own recovery within one logical turn, in the package session

**Owner (decided 2026-11-18, proposed).** The package's Codex session (`packages/agent-runtime/src/codex/`) owns the logical turn and its attempts: it already owns the turn id, the native id binding, the lifecycle, the result, and the limit facts, and only it sees `turn/completed` before publication. Kawai's adapter only projects what the package publishes. A Kawai-side retry would need the package to publish a failed attempt as a completed turn, which reopens the idle gap and mailbox release this design rejects.

Concretely:
- `capacityRetry.ts` is the pure policy (D3) with clock, random, and timer seams.
- `capacityRecovery.ts` owns the effects for one session: the deadline, the one pending timer or active attempt, the generation guard (D5), the retired attempt ids, and the continuation request. `turnCompleted` hands a matching failed attempt to it before deciding the turn; it answers "settle as before" or "recovering".
- The session option `capacityRecovery: 'bounded' | 'off'` (additive). Omitted or `'off'` is today's behavior exactly: overload still produces its login-scoped limit events (upstream non-final, terminal final) and the turn ends on a terminal failure. Only `'bounded'` both suppresses overload limit events and owns the retry, so suppression never exists without recovery. Any other runtime value reads as `'off'`. Kawai passes `'bounded'` for Codex chats. Table O fixes these semantics.
- Public additions, all optional fields or new union members: the activity's `retry` gains `owner` (`'provider' | 'capacity'`), `ordinal`, `nextRetryAt`, and `deadline`; one new informational event `{ type: 'capacity_retry', turnId, ordinal, nextRetryAt, deadline, expiring }`; the exported continuation wrapper constant. No existing type, event, or option changes meaning.

Recovery mechanics, as planned before the move:

The policy is `capacityRetry.ts`; `capacityRecovery.ts` owns the effects. Keep `activeTurnId`, original trigger, mailbox claim, approval policy, and logical usage baseline across Codex attempt ids. Do not emit `turn_completed` or a terminal error for a recoverable attempt. Retire that attempt id before scheduling the next one. Track processed and retired attempt ids so late completions, item events, and `turn/started` cannot attach to the next attempt. Preserve existing independently scoped account-usage updates.

There is at most one active attempt or one pending backoff timer. Codex's `willRetry: true` reports activity for the current attempt only; it neither opens a Kawai retry window nor schedules a local retry. `willRetry: false` alone also does not schedule one: wait for authoritative matching `turn/completed` so two layers cannot act concurrently.

Do not reset the logical turn's token baseline on a continuation's `turn/started` (the turn's token facts in `codex/facts.ts`, over the generation's consecutive thread totals); aggregate usage across the logical turn. Emit one final completion/interruption per logical turn.

Alternative: complete each failed attempt and send a fresh synthetic user turn. Rejected because it exposes idle gaps, allows mailbox reassignment, duplicates triggers, and splits logical usage.

### D3: Fixed window and equal-jitter backoff

On the first eligible terminal capacity failure set `deadline = monotonicNow + 600_000 ms`. Store an equivalent epoch deadline for display. For retry ordinal n starting at 1, set `cap = min(60_000, 2_000 * 2^(n-1))` and choose integer delay uniformly in `[cap/2, cap]`. This yields positive delays, avoids tight loops at random zero, and caps all delays at sixty seconds. These base and jitter choices are planning defaults; the ten-minute window and sixty-second cap are confirmed behavior.

If the next due time is at or after the deadline, arm only the deadline wakeup and show that recovery is expiring; do not squeeze an extra attempt into the remaining time. Recheck the monotonic deadline inside every timer callback immediately before dispatch. Neither progress, duplicate frames, nor another capacity failure extends it. The ordinal counts Kawai retries only, not Codex's internal attempts.

The bound limits when Kawai may start another attempt. An attempt already running at the deadline may finish; it is not interrupted in the middle of a tool call. A capacity failure after that point terminates immediately. This avoids cancelling useful work solely because time elapsed. An ordinary later user turn gets a fresh budget. Browser disconnect does not affect the budget; backend restart loses it and schedules nothing automatically.

### D4: Continue history instead of resending the request

Use `turn/start` on the same thread and inherited model with a short, explicitly delimited internal continuation input: the previous attempt stopped on temporary model capacity; continue the existing request using the conversation and completed tool results; inspect current state before repeating an operation. Never resend the original prompt, peer envelope, or tool output, and never use the peer message id as the continuation's `clientUserMessageId`. Generate a unique recovery input id per attempt. No fresh thread, rollback, file restoration, or automatic tool execution is part of recovery.

The local generated `TurnStartParams` permits an input array but does not establish whether empty input resumes useful work. Choose explicit text continuation using the already exercised request shape instead of depending on unverified empty-input behavior. Give that text a versioned reserved wrapper recognizable by replay; render it as an internal recovery notice rather than a user/peer message. It grants no permissions. The wrapper must not contain a mailbox envelope or create a receipt. Replay can retain protocol attempt boundaries and historical errors; ephemeral countdowns are not reconstructed or restarted. Do not claim replay can recover in-memory logical turn ids after a crash.

### D5: Cancel through one generation guard

Pending effects capture driver/client identity, logical turn generation, and retired attempt identity. Stop, interrupt, archive/kill/shutdown, process exit, and superseding input during backoff invalidate the generation and clear the timer before emitting a terminal event. Guard asynchronous `ready`/`turn/start` resolution as well as timer callbacks, including before sending after an await. A late start response must still be interrupted if an attempt was actually dispatched before Stop, following the existing `turnStarting` handshake; it must never reopen the cancelled logical turn. Stale callbacks therefore cannot dispatch, complete, replace activity, or extend the budget; their one permitted effect is a single cleanup interrupt of the already-dispatched cancelled attempt, scoped to its original client, thread, and attempt id (a retry dispatched and then stopped still awaits its `turn/start` response, and the driver interrupts the id that response supplies through the existing `turnStarting` handshake). A stale callback never touches a newer attempt.

When a human sends during backoff, interrupt the old logical turn locally and start the new human turn on the same thread. During an actually running attempt retain current steering behavior. Ordinary group and normal direct deliveries cannot arrive mid-turn because the recipient stays working. Urgent direct mail is the preserved exception: the dispatcher deliberately selects the busy recipient, interrupts it, and delivers the envelope (`src/server/team/dispatcher.ts`, `push(…, interrupt)` at :468-482 as of `f52963d0`; the main codex-chat-sessions spec's "Interrupting a Codex turn" requirement mandates it). In the package this arrives as the session's `interrupt()`. That interruption invalidates the recovery generation and clears the timer before the urgent turn starts, and the interrupted logical turn is not resumed into recovery afterward. An unexpected process exit uses existing process-error settlement and cancels recovery; reconnect alone has no scheduling effect.

### D6: Additive activity data and existing Stop control

Extend the package's activity state (`common/activity.ts`, `codex/activity.ts`), Kawai's shared `ChatActivity`, and the adapter's projection with optional capacity retry owner/reason, ordinal, epoch `nextRetryAt` when an attempt is scheduled, and `retryDeadline`. Keep upstream retry presentation compatible; do not display a fabricated maximum attempt count for a time-bounded policy. Publish capacity activity while waiting, including a final countdown when no further attempt fits; restore requesting/thinking/tool phases once the attempt runs. `ChatActivityRow` uses its existing client clock to show countdown and deadline, with accessible text. Existing snapshots carry the full activity on reconnect. Keep session status working during backoff so the existing Stop action and mailbox eligibility rules continue to work. Pending cards still follow existing priority rules.

### D7: One change, not a classification-only slice

Suppressing overload limit events (task 1.1, `'bounded'` only) without recovery would stop the one-hour shared-home cooldown while giving the turn no retry, so a capacity failure would end the turn and the next mail would hit the same overloaded model at once. The change therefore lands as one plan change: tasks 1.x–4.x in one result. A checkpoint may review 1.x early, but nothing lands without 2.x.

### Acceptance oracles

The following are observable decision tables; implementation must commit them verbatim as table-driven tests. They are unchanged by the 2026-11-18 retarget except where a seam is named: "driver" now means the package's Codex session with a scripted app-server transport, and "production manager" means Kawai's `ChatSessionManager` with the in-tree package. L1's single scoped cleanup interrupt (the planning review's B3 rule) stays the only effect a stale callback may have. `*` is a don't-care. Mutants are mandatory checks against missing production wiring, as well as reducer logic. Reviewed hazards: B1 (stale actor), M1 (test-only composition), and readers disagreeing on derived state in `docs/oracle-hazards.md`.

Option table (added 2026-11-18 for review finding F2): axes are the session's `capacityRecovery` value and the overload source; seam is the package session over a scripted app-server with `onLimitEvent` and `onActivity` subscribed. Every other row of this section (C, L, T, P1–P3) is stated for `'bounded'`; W and P4–P5 hold through Kawai, which passes `'bounded'`.

| Oracle | Option | Source | Observable result |
| --- | --- | --- | --- |
| O1 | omitted | `serverOverloaded` upstream retry (`willRetry`) | Today's non-final login-scoped limit event and provider retry activity; no capacity state |
| O2 | omitted | `serverOverloaded` terminal failed attempt | Today's final login-scoped limit event; the turn ends with its error; no continuation, no `capacity_retry` event, no new activity fields |
| O3 | `'off'` | upstream retry | As O1 |
| O4 | `'off'` | terminal failed attempt | As O2 |
| O5 | `'bounded'` | upstream retry | No limit event; provider-owned retry activity only if `willRetry` (L7); no capacity attempt (C1) |
| O6 | `'bounded'` | terminal failed attempt | No limit event; capacity recovery per L2–L4 (C2) |
| O7 | any | usage, rate, or session-budget kind | Identical events, scopes, and resets in all modes (C3–C4) |
| O8 | an unrecognized string | either source | As O3–O4 |

Mutants: unconditional suppression (the review's reproduction: an omitted consumer stops receiving the terminal overload event) fails O2/O4; recovery enabled when omitted fails O2; `codexLimitScope` changed fails the exported-scope row kept in `codexLimits.test.ts`; `'bounded'` suppression leaking into quota kinds fails O7; suppression in `'bounded'` without recovery fails O6.

Classification table (`'bounded'`): axes are structured kind, source, and quota snapshot. Source is upstream retry or terminal failed attempt; snapshot is exhausted or absent/non-exhausted.

| Oracle | Kind | Source | Snapshot | Observable result |
| --- | --- | --- | --- | --- |
| C1 | serverOverloaded | upstream retry | * | No Kawai attempt dispatched; no quota event or cooldown |
| C2 | serverOverloaded | terminal failed attempt | * | Capacity recovery considered; no quota event or cooldown |
| C3 | usageLimitExceeded or rateLimitExceeded | * | * | Existing final/non-final and exhausted-reset rules apply with shared-home scope |
| C4 | sessionBudgetExceeded | * | * | Existing final/non-final rules apply with profile-only scope |
| C5 | any other kind, missing, or object variant | * | * | No capacity recovery; existing unrelated-error behavior |

Lifecycle table axes: callback owner is current or stale; state is active attempt (A), backoff (B), or ended (E); event classes are those below. Validity normalizes notifications for already-retired ids to stale. Deadline due and retry due are distinguished by checking the current clock, not by trusting the timer's name. Expiry is evaluated first: whenever now >= deadline the expiry rows apply, so L8's early-wake row also requires now < deadline; D3's expiring state (an armed deadline wakeup while the recorded retry time is already at or past the deadline) resolves as expiry (L10), never as a retained early wake.

| Oracle | Owner | State | Event / time condition | Observable result |
| --- | --- | --- | --- | --- |
| L1 | stale | * | any | No dispatch, terminal event, activity replacement, or budget extension; the one permitted effect is a single cleanup interrupt scoped to the already-dispatched cancelled attempt's original client, thread, and attempt id, never a newer attempt |
| L2 | current | A | matching capacity completion, next due < deadline | Remain working; publish retry timing; schedule exactly one wakeup |
| L3 | current | A | matching capacity completion, now < deadline <= next due | Remain working until deadline; no further attempt; publish expiring recovery |
| L4 | current | A | matching capacity completion, now >= deadline | One terminal capacity error/completion; waiting; no quota outcome |
| L5 | current | A | matching success completion | One success completion; waiting; no timer |
| L6 | current | A | matching non-capacity failure or start RPC rejection | Existing terminal error/quota handling once; no capacity timer |
| L7 | current | A | upstream error notification | No competing dispatch or completion; show upstream retry activity only if willRetry |
| L8 | current | B | wakeup, now < deadline and now < next due | No dispatch; retain one wakeup for due time |
| L9 | current | B | wakeup, next due <= now < deadline | One continuation request, same thread/model; working |
| L10 | current | B | wakeup, now >= deadline | One exhausted-capacity completion/error; waiting; no continuation |
| L11 | current | A or B | Stop / interrupt | One interruption; no pending retry; interrupt dispatched attempt if necessary |
| L12 | current | A or B | archive / kill / shutdown / process exit | Existing lifecycle settlement; no pending retry or later dispatch |
| L13 | current | B | new human input | Old logical turn interrupted; one new human input sent on same thread; old callbacks inert |
| L14 | current | A | new human input | Existing active-turn steering; no parallel capacity attempt |
| L15 | current | A or B | browser disconnect / reconnect | No extra request; reconnect snapshot restores current activity |
| L16 | current | A or B | backend crash then restart | No retry restored; history readable; no automatic continuation |
| L17 | current | A | item / usage / approval / question frames | Existing streaming/request behavior; usage baseline spans attempts |
| L18 | current | E | new human input | One new logical turn and input; fresh capacity budget if subsequently needed |
| L19 | current | E | other notification / timer / lifecycle / reconnect | No automatic capacity request or reopened old turn; existing idle/lifecycle behavior |
| L20 | current | A or B | urgent direct delivery | Existing urgent interruption after pending cards resolve; recovery generation invalidated and timer cleared before the urgent turn starts; a dispatched attempt is interrupted if one is running; no recovery resumes afterward |

Completeness claim: for the listed event alphabet, each reachable combination of owner, state, event, and timing matches exactly one row. Owner-stale takes precedence by definition. Expiry is evaluated before wake timing: in B, L8 requires now < deadline and now < next due while L10 covers now >= deadline, so the rows stay disjoint; the other rows are disjoint by event class. In E, only new input is L18; all remaining events are L19; urgent direct delivery in E is ordinary idle delivery outside the recovery model. In B, matching attempt/item/upstream-error frames are unreachable as current: the attempt was retired and maps to L1. In A, a retry wakeup is unreachable as current because dispatch consumes its timer token; delayed duplicate wakeups map to L1. Urgent direct delivery in A or B is row L20, the only mailbox event that can interrupt recovery. A matching capacity completion with no deadline initializes it before the three disjoint timing cases L2/L3/L4. Account-level usage updates remain independent of attempt recovery. Unsupported protocol frame types retain the existing ignore behavior and cannot dispatch retries.

Timing table uses an injected random fraction r in `[0,1)`, integer milliseconds, and an injected monotonic clock. The sampled formula is `floor(cap/2 + r * (cap/2 + 1))` clamped to cap.

| Oracle | Inputs | Observable result |
| --- | --- | --- |
| T1 | n=1, r=0 | Retry delay 1,000 ms |
| T2 | n=2, r approaching 1 | Retry delay 4,000 ms |
| T3 | n>=6, any r | Retry delay in [30,000, 60,000] ms |
| T4 | due exactly deadline or later | No continuation dispatch |
| T5 | timer scheduled before deadline, callback executes at deadline or later | No continuation dispatch |
| T6 | wall clock jumps while monotonic time is stable | Dispatch eligibility and remaining budget unchanged |

Composition/replay table:

| Oracle | Input | Observable result |
| --- | --- | --- |
| W1 | Production manager, delivered mail, capacity failure then success | Claim/receipt retained; no park/forward/release; one logical completion; no sibling cooldown |
| W2 | Production manager, delivered mail, capacity window exhausted | One ordinary failure; no quota-driven mailbox resolution or sibling cooldown |
| W3 | Production manager, retry ends on actual usage limit | Existing quota event, home cooldown, and mailbox resolution still occur |
| W4 | Completed tool result then capacity continuation | Original input/envelope sent once; no tool replay by Kawai; original policy/thread/model retained; logical usage covers all attempts |
| W5 | Rollout with original input and internal continuation inputs | Original input appears once; recovery inputs are notices, not human/peer input; no new receipt; completed tools retained |
| W6 | Independent pre-existing quota cooldown plus capacity error | Existing cooldown neither cleared nor extended |
| W7 | Capacity backoff activity delivered through production snapshot/push and client row | Actual attempt/countdown/deadline visible; no false 1/1 maximum; ordinary upstream retry rendering remains compatible |
| W8 | Production manager/mailbox: urgent direct mail delivered during backoff | Urgent envelope delivered once with its original receipt; recovery generation invalidated; no old continuation dispatched afterward; the urgent mail is never parked, forwarded, or released |

Properties, each with one invariant and no new dependency:

- P1: At most one capacity continuation is pending or active. Generate 1,000 seeded command sequences of 100 events from lifecycle rows, duplicate completions, early/late timers, and upstream retries; seams are pure policy plus the package's Codex session over a scripted app-server transport with fake clock/timers/random; seed `0xCA9AC17`.
- P2: No continuation starts at or after the original monotonic deadline. Generate 1,000 timing sequences including equality, oversleep, wall-clock jumps, and repeated failures; seam is the `turn/start` requests the real package session sends; seed `0xCA9AC18`.
- P3: Invalidation prevents every old generation from dispatching later work. Generate 1,000 cancellation/supersession sequences with deferred ready/start responses, stale notifications, urgent-delivery invalidations, and stale cleanup interrupts; seam is the package session's request and event log; seed `0xCA9AC19`.
- P4: Capacity alone produces zero quota limit events. Generate 1,000 capacity chains with exhausted snapshots and sibling profiles through production manager/limit-store wiring; seed `0xCA9AC20`.
- P5: Automatic continuation never duplicates the original input. Generate 1,000 chains with human or peer input and completed tools; seam is request payloads plus replayed events; seed `0xCA9AC21`.

Run model-based tests using the lifecycle table as the independent reference model (not production reducer output). Include replay, supersession, and crash injection before/after continuation dispatch and before/after final event emission; there is no retry database transaction. Also interrupt between `ready` resolution, request dispatch, and start response. After crash, a newly constructed driver has no pending retry and replay performs no effects. Cover C/W rows through the real manager/limit composition and W7 through the production activity pipeline to kill the M1 missing-wiring hazard. Report each oracle id with its test title and the named mutant it kills.

### Deferred to implementation evidence

The following are planning dispositions, not executed evidence; each becomes a captured obligation in the implementation's evidence map (task 4.2):

- Current/stale normalization for `turn/started` and a remotely interrupted `turn/completed` follows the driver's existing rules: frames naming an interrupted or retired turn id are dropped or normalize to stale (`packages/agent-runtime/src/codex/events.ts` turn mapping, `codex/turns.ts` `completionOutcome`, `codex/session.ts` `turnFor`/`turnStarted`, `codex/protocol/`). The independent reference model applies the same normalization instead of new rows.
- Approvals, questions, and dynamic tool calls are server requests, not notifications (`codex/session.ts` `serverRequest` at :412; `codex/requests.ts`; `requests.cancelAll()` settles them on process exit and stop, `session.ts:404`, `:557`). A retired attempt's outstanding request is cancelled with the attempt. Whether the installed server re-raises such frames after a terminal failed turn is unknown until runtime evidence; if they arrive they are retired-attempt input (L1 class).
- The internal continuation wrapper's exact bytes, grammar, malformed/lookalike fallback, and replay fixtures are pinned during implementation (task 3.2); planning names no wrapper bytes or new shared message names.
- `TurnStartParams` accepting text input is a type shape, not proof of installed behavior: whether the installed app-server retains failed-turn context, its frame ordering, and its id timing remain future prerequisite evidence to capture at implementation time. The ten-minute window, sixty-second cap, classification, and cancellation contracts are the confirmed planning behavior.

## Risks / Trade-offs

- [Continuation can encourage an agent to repeat an operation] -> Include completed context and an inspect-before-repeat instruction; assert Kawai itself resends neither requests nor tool calls. Do not promise agent-level exactly-once effects.
- [A running attempt can outlast ten minutes] -> The bounded window limits new retries, explicitly allowing an in-flight attempt to finish safely.
- [Backend restart loses a pending recovery] -> Retry jobs remain ephemeral; never silently replay work after restart. The existing history supports explicit continuation.
- [Late frames can reopen or corrupt a new logical turn] -> Validate generation and retired attempt identity at both timer and protocol boundaries, including nested turn ids on completion frames.
- [Old overload cooldowns remain visible] -> Preserve historical events and let existing cooldowns expire; no database rewrite.
- [Client and server clocks differ] -> Use epoch timestamps for display, monotonic time for dispatch, and clamp displayed countdowns to zero.

## Migration Plan

No schema migration or feature flag. Ship the driver policy, classification change, activity additions, replay recognition, and tests together. Update AGENTS.md's Codex behavior description during implementation. Existing clients ignore optional activity fields; updated clients retain ordinary retry rendering. Rollback restores prior stopping/cooldown behavior and loses any ephemeral pending recovery; no stored jobs need cleanup.

## Production composition and verification boundaries

- Package level (tasks 1.x–2.x): O, C, T, L, and P1–P3 run against the real package session over a scripted app-server transport (`packages/agent-runtime/__tests__/`), the same seam `codexDriver.test.ts` uses.
- Kawai level (tasks 3.x–4.x): W1–W3, W6, W8, and P4 run through `ChatSessionManager`, the limit store, `LimitOutcomes`, and the dispatcher with the in-tree package and a scripted Codex app-server; W7 through the production activity push and snapshot into `ChatActivityRow`; W5 and P5 through `codexRollout.ts` over rollout fixtures. Each guarded seam has one row through this composition and a mutant that removes the wiring (the `'bounded'` option not passed, the activity fields not projected, the wrapper not recognized).
- Affected existing workflows to keep green: real quota handling (C3, C4, W3), other providers' overload events, the Codex interrupt and urgent-delivery tests, rollout replay of ordinary turns, and the package's own Codex suites.
- Deferred installed-protocol facts (above) stay explicit: they are captured at implementation time, not assumed, and no credentialed or live model probe is part of this planning.

## Execution checkpoints

1. After 1.1–1.2 and the first L rows of 2.1: one production path at a pinned commit — the package session receives a terminal `serverOverloaded`, sends one continuation `turn/start` on the same thread, binds the new attempt, and completes the logical turn once; plus L4 (exhaustion) as the failure case. Reviewed before 2.2.
2. After 2.3: L1–L20, T1–T6, and P1–P3 green with their mutants killed.
3. After 4.1: W1–W8 and P4–P5 through the Kawai composition; then 4.2–4.3.

## Implementation contract

### Acceptance

- A1: With `capacityRecovery: 'bounded'` (as Kawai passes), a Codex `serverOverloaded`, retrying or terminal, records no quota limit event and creates or extends no cooldown, while usage, rate, and session-budget limits keep their existing events, scopes, and resets (C1–C5, W6).
- A2: A terminal `serverOverloaded` keeps the logical turn working and retries on the same thread and model with D3's delays, inside a ten-minute window from the first such failure, never starting an attempt at or after the deadline (T1–T6, L2–L4, L8–L10, P2).
- A3: At most one continuation is pending or active per session, stale callbacks only ever send the one scoped cleanup interrupt, and Stop, interrupt, lifecycle end, new human input, and urgent delivery cancel recovery (L1, L11–L16, L18–L20, P1, P3).
- A4: The original input or peer envelope is sent once, completed tools are not replayed by Kawai, logical usage spans attempts, and exactly one terminal event is published per logical turn (L5–L7, L17, W4, P5).
- A5: Delivered mail stays claimed through recovery and gets no park, forward, or release from capacity alone; a real quota failure after capacity follows the existing quota path (W1–W3, W8, P4).
- A6: The chat shows the capacity attempt, countdown, and deadline through the production snapshot and push, without a fabricated maximum, and ordinary upstream retry rendering is unchanged (W7).
- A7: Replay shows original input once and recovery input as an internal notice, creating no receipt (W5).

### Invariants

- I1: Only the package's Codex session decides a Codex logical turn's attempts; Kawai never starts a capacity attempt.
- I2: The package's public API changes only additively, its version stays 0.1.1, and nothing is published; with the option omitted or `'off'`, package behavior, including `codexLimitScope` and the upstream and terminal overload limit callbacks, is unchanged (O1–O4, O8).
- I3: `codex/session.ts`, `codexRuntime.ts`, and `ChatSessionManager.ts` do not grow in net lines.
- I4: Retry state is never persisted and never resumed after a backend restart.
- I5: Claude retry behavior and other providers' overload handling are unchanged.

### Scope

- `openspec/changes/codex-capacity-retry/**`
- `packages/agent-runtime/src/codex/**`
- `packages/agent-runtime/src/usage/limits.ts`
- `packages/agent-runtime/src/common/activity.ts`
- `packages/agent-runtime/src/events.ts`
- `packages/agent-runtime/src/options.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/__tests__/**`
- `src/server/chat/provider/codexRuntime.ts`
- `src/server/chat/provider/codexRuntimeSupport.ts`
- `src/server/chat/provider/runtimeEvents.ts`
- `src/server/chat/provider/codexDriverTypes.ts`
- `src/server/chat/codex/codexLimits.ts`
- `src/server/chat/codex/codexRollout.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/shared/chat.ts`
- `src/client/components/chat/ChatActivityRow.tsx`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `AGENTS.md`
- `docs/architecture/chat.md`

### Verification

- V1: O1–O8, C1–C5, T1–T6, L1–L20, and W1–W8 are committed verbatim as table-driven tests at the seams named above, each with its named mutant failing, including the wiring mutants of W1 and W7.
- V2: P1–P5 run at their seeds (`0xCA9AC17`–`0xCA9AC21`) with 1,000 declared cases each through `propertyCases`, the full counts under `--full-properties`, with the lifecycle table as the independent reference model and crashes before and after continuation dispatch and final emission.
- V3: The package's tests run through the root runner (`bun run test <files>`), and `bun run typecheck` covers the package project.
- V4: A citation preflight over the result's evidence map reports zero unresolved; `openspec validate codex-capacity-retry --strict` and `bun run check --full-properties` pass on the clean committed head under the pinned Bun; `scripts/verify-result.ts` reports the head.

### Excluded

- X1: Publishing or versioning `@motuslabs/agent-runtime`, and extract-agent-runtime's consumer-access closeout (its task 8.4).
- X2: Model or provider switching, generic retries of other errors, persisted retry jobs, a settings UI, and Claude retry policy.
- X3: Changing the Codex error category (`auth.ts:68`), which no Kawai code reads.
- X4: Live or credentialed Codex probes; installed-protocol facts are captured at implementation time.
