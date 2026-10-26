# Design

## Context

See proposal.md for motivation. `CodexSessionDriver.completeTurn` currently clears the active turn, emits a final limit signal, emits completion/error drafts, and refreshes status for every failed Codex attempt. `onNotification` shows an upstream retry as a hard-coded 1/1 activity but does not schedule retries. `codexLimits.ts` maps `serverOverloaded` to login scope, and tests explicitly pin that behavior. `LimitOutcomes` consumes final signals and logical turn completion to resolve mailbox work; a human-only turn has no mailbox resume.

The durable `profile-limit-handling` requirements currently include overload in quota events. The two modified requirement blocks explicitly carve out Codex capacity errors. Other providers' overload handling and actual Codex quota handling remain as specified.

The shared activity model already has `retrying`, but lacks a next-attempt time, deadline, and retry owner. `codexRollout.ts` reconstructs history from protocol turn markers and user response items, so a continuation prompt would otherwise look like human input during replay.

## Goals / Non-Goals

**Goals:** Keep the existing driver/manager lifecycle and mailbox ownership intact through capacity retries; make timing deterministic under tests; prevent stale work after cancellation; keep token accounting across attempts correct.

**Non-Goals:** Model switching, provider switching, generic retries of every error or RPC rejection, persisted retry jobs, changes to Claude retry policy, or a settings UI. The application can prevent its own tool-call replay; it cannot guarantee an agent never independently chooses to repeat an operation.

## Decisions

### D1: Separate capacity from quota at the structured error boundary

Recognize only a failed matching Codex attempt whose `error.codexErrorInfo` is exactly `serverOverloaded`. Remove that kind from `codexLimitScope`, so neither upstream retry notifications nor terminal capacity attempts emit quota signals. Exhaustion ends as an ordinary capacity error, never a fabricated quota event. Cached exhausted quota windows do not supply a capacity deadline. A later real quota failure follows the existing quota path unchanged.

Alternative: keep recording final overload limit events and override cooldown duration. Rejected because the same events also drive parking and forwarding and imply account exhaustion. Retain existing historical events without rewriting the append-only record; already-recorded cooldowns expire normally.

### D2: Own recovery within one logical Kawai turn

Extract a small pure retry policy/reducer (suggested `codexCapacityRetry.ts`), with clock, random, and timer seams. The driver owns the effects. Keep `activeTurnId`, original trigger, mailbox claim, approval policy, and logical usage baseline across Codex attempt ids. Do not emit `turn_completed` or a terminal error for a recoverable attempt. Retire that attempt id before scheduling the next one. Track processed and retired attempt ids so late completions, item events, and `turn/started` cannot attach to the next attempt. Preserve existing independently scoped account-usage updates.

There is at most one active attempt or one pending backoff timer. Codex's `willRetry: true` reports activity for the current attempt only; it neither opens a Kawai retry window nor schedules a local retry. `willRetry: false` alone also does not schedule one: wait for authoritative matching `turn/completed` so two layers cannot act concurrently.

Do not reset `turnStartTotal` on each continuation's `turn/started`; aggregate usage across the logical turn, with the existing cumulative-total delta logic. Emit one final completion/interruption per logical turn.

Alternative: complete each failed attempt and send a fresh synthetic user turn. Rejected because it exposes idle gaps, allows mailbox reassignment, duplicates triggers, and splits logical usage.

### D3: Fixed window and equal-jitter backoff

On the first eligible terminal capacity failure set `deadline = monotonicNow + 600_000 ms`. Store an equivalent epoch deadline for display. For retry ordinal n starting at 1, set `cap = min(60_000, 2_000 * 2^(n-1))` and choose integer delay uniformly in `[cap/2, cap]`. This yields positive delays, avoids tight loops at random zero, and caps all delays at sixty seconds. These base and jitter choices are planning defaults; the ten-minute window and sixty-second cap are confirmed behavior.

If the next due time is at or after the deadline, arm only the deadline wakeup and show that recovery is expiring; do not squeeze an extra attempt into the remaining time. Recheck the monotonic deadline inside every timer callback immediately before dispatch. Neither progress, duplicate frames, nor another capacity failure extends it. The ordinal counts Kawai retries only, not Codex's internal attempts.

The bound limits when Kawai may start another attempt. An attempt already running at the deadline may finish; it is not interrupted in the middle of a tool call. A capacity failure after that point terminates immediately. This avoids cancelling useful work solely because time elapsed. An ordinary later user turn gets a fresh budget. Browser disconnect does not affect the budget; backend restart loses it and schedules nothing automatically.

### D4: Continue history instead of resending the request

Use `turn/start` on the same thread and inherited model with a short, explicitly delimited internal continuation input: the previous attempt stopped on temporary model capacity; continue the existing request using the conversation and completed tool results; inspect current state before repeating an operation. Never resend the original prompt, peer envelope, or tool output, and never use the peer message id as the continuation's `clientUserMessageId`. Generate a unique recovery input id per attempt. No fresh thread, rollback, file restoration, or automatic tool execution is part of recovery.

The local generated `TurnStartParams` permits an input array but does not establish whether empty input resumes useful work. Choose explicit text continuation using the already exercised request shape instead of depending on unverified empty-input behavior. Give that text a versioned reserved wrapper recognizable by replay; render it as an internal recovery notice rather than a user/peer message. It grants no permissions. The wrapper must not contain a mailbox envelope or create a receipt. Replay can retain protocol attempt boundaries and historical errors; ephemeral countdowns are not reconstructed or restarted. Do not claim replay can recover in-memory logical turn ids after a crash.

### D5: Cancel through one generation guard

Pending effects capture driver/client identity, logical turn generation, and retired attempt identity. Stop, interrupt, archive/kill/shutdown, process exit, and superseding input during backoff invalidate the generation and clear the timer before emitting a terminal event. Guard asynchronous `ready`/`turn/start` resolution as well as timer callbacks, including before sending after an await. A late start response must still be interrupted if an attempt was actually dispatched before Stop, following the existing `turnStarting` handshake; it must never reopen the cancelled logical turn.

When a human sends during backoff, interrupt the old logical turn locally and start the new human turn on the same thread. During an actually running attempt retain current steering behavior. A new mailbox delivery cannot supersede the recovery because the recipient stays working. An unexpected process exit uses existing process-error settlement and cancels recovery; reconnect alone has no scheduling effect.

### D6: Additive activity data and existing Stop control

Extend shared `ChatActivity` and the pure activity projection with optional capacity retry owner/reason, ordinal, epoch `nextRetryAt` when an attempt is scheduled, and `retryDeadline`. Keep upstream retry presentation compatible; do not display a fabricated maximum attempt count for a time-bounded policy. Publish capacity activity while waiting, including a final countdown when no further attempt fits; restore requesting/thinking/tool phases once the attempt runs. `ChatActivityRow` uses its existing client clock to show countdown and deadline, with accessible text. Existing snapshots carry the full activity on reconnect. Keep session status working during backoff so the existing Stop action and mailbox eligibility rules continue to work. Pending cards still follow existing priority rules.

### Acceptance oracles

The following are observable decision tables; implementation must commit them verbatim as table-driven tests. `*` is a don't-care. Mutants are mandatory checks against missing production wiring, as well as reducer logic. Reviewed hazards: B1 (stale actor), M1 (test-only composition), and readers disagreeing on derived state in `docs/oracle-hazards.md`.

Classification table: axes are structured kind, source, and quota snapshot. Source is upstream retry or terminal failed attempt; snapshot is exhausted or absent/non-exhausted.

| Oracle | Kind | Source | Snapshot | Observable result |
| --- | --- | --- | --- | --- |
| C1 | serverOverloaded | upstream retry | * | No Kawai attempt dispatched; no quota event or cooldown |
| C2 | serverOverloaded | terminal failed attempt | * | Capacity recovery considered; no quota event or cooldown |
| C3 | usageLimitExceeded or rateLimitExceeded | * | * | Existing final/non-final and exhausted-reset rules apply with shared-home scope |
| C4 | sessionBudgetExceeded | * | * | Existing final/non-final rules apply with profile-only scope |
| C5 | any other kind, missing, or object variant | * | * | No capacity recovery; existing unrelated-error behavior |

Lifecycle table axes: callback owner is current or stale; state is active attempt (A), backoff (B), or ended (E); event classes are those below. Validity normalizes notifications for already-retired ids to stale. Deadline due and retry due are distinguished by checking the current clock, not by trusting the timer's name.

| Oracle | Owner | State | Event / time condition | Observable result |
| --- | --- | --- | --- | --- |
| L1 | stale | * | any | No request, terminal event, activity replacement, or budget extension |
| L2 | current | A | matching capacity completion, next due < deadline | Remain working; publish retry timing; schedule exactly one wakeup |
| L3 | current | A | matching capacity completion, now < deadline <= next due | Remain working until deadline; no further attempt; publish expiring recovery |
| L4 | current | A | matching capacity completion, now >= deadline | One terminal capacity error/completion; waiting; no quota outcome |
| L5 | current | A | matching success completion | One success completion; waiting; no timer |
| L6 | current | A | matching non-capacity failure or start RPC rejection | Existing terminal error/quota handling once; no capacity timer |
| L7 | current | A | upstream error notification | No competing dispatch or completion; show upstream retry activity only if willRetry |
| L8 | current | B | wakeup, now < next due | No dispatch; retain one wakeup for due time |
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

Completeness claim: for the listed event alphabet, each reachable combination of owner, state, event, and timing matches exactly one row. Owner-stale takes precedence by definition; the other rows are disjoint by event class. In E, only new input is L18; all remaining events are L19. In B, matching attempt/item/upstream-error frames are unreachable as current: the attempt was retired and maps to L1. In A, a retry wakeup is unreachable as current because dispatch consumes its timer token; delayed duplicate wakeups map to L1. A matching capacity completion with no deadline initializes it before the three disjoint timing cases L2/L3/L4. Account-level usage updates remain independent of attempt recovery. Unsupported protocol frame types retain the existing ignore behavior and cannot dispatch retries.

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

Properties, each with one invariant and no new dependency:

- P1: At most one capacity continuation is pending or active. Generate 1,000 seeded command sequences of 100 events from lifecycle rows, duplicate completions, early/late timers, and upstream retries; seams are pure policy plus scripted production driver with fake client/clock/timers/random; seed `0xCA9AC17`.
- P2: No continuation starts at or after the original monotonic deadline. Generate 1,000 timing sequences including equality, oversleep, wall-clock jumps, and repeated failures; seam is dispatched requests from the real driver; seed `0xCA9AC18`.
- P3: Invalidation prevents every old generation from dispatching later work. Generate 1,000 cancellation/supersession sequences with deferred ready/start responses and stale notifications; seam is driver dispatch/event log; seed `0xCA9AC19`.
- P4: Capacity alone produces zero quota limit events. Generate 1,000 capacity chains with exhausted snapshots and sibling profiles through production manager/limit-store wiring; seed `0xCA9AC20`.
- P5: Automatic continuation never duplicates the original input. Generate 1,000 chains with human or peer input and completed tools; seam is request payloads plus replayed events; seed `0xCA9AC21`.

Run model-based tests using the lifecycle table as the independent reference model (not production reducer output). Include replay, supersession, and crash injection before/after continuation dispatch and before/after final event emission; there is no retry database transaction. Also interrupt between `ready` resolution, request dispatch, and start response. After crash, a newly constructed driver has no pending retry and replay performs no effects. Cover C/W rows through the real manager/limit composition and W7 through the production activity pipeline to kill the M1 missing-wiring hazard. Report each oracle id with its test title and the named mutant it kills.

## Risks / Trade-offs

- [Continuation can encourage an agent to repeat an operation] -> Include completed context and an inspect-before-repeat instruction; assert Kawai itself resends neither requests nor tool calls. Do not promise agent-level exactly-once effects.
- [A running attempt can outlast ten minutes] -> The bounded window limits new retries, explicitly allowing an in-flight attempt to finish safely.
- [Backend restart loses a pending recovery] -> Retry jobs remain ephemeral; never silently replay work after restart. The existing history supports explicit continuation.
- [Late frames can reopen or corrupt a new logical turn] -> Validate generation and retired attempt identity at both timer and protocol boundaries, including nested turn ids on completion frames.
- [Old overload cooldowns remain visible] -> Preserve historical events and let existing cooldowns expire; no database rewrite.
- [Client and server clocks differ] -> Use epoch timestamps for display, monotonic time for dispatch, and clamp displayed countdowns to zero.

## Migration Plan

No schema migration or feature flag. Ship the driver policy, classification change, activity additions, replay recognition, and tests together. Update AGENTS.md's Codex behavior description during implementation. Existing clients ignore optional activity fields; updated clients retain ordinary retry rendering. Rollback restores prior stopping/cooldown behavior and loses any ephemeral pending recovery; no stored jobs need cleanup.
