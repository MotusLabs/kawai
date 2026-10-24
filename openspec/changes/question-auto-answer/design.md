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
