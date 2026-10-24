# Proposal

## Why

When a chat agent asks a question through `AskUserQuestion`, it stops until
the human answers — even when the agent has already marked one option as
recommended. Unattended chats, and especially spawned team members whose
questions block mail, staffing slots, and the lead, can sit idle for hours on
a question whose recommended answer the human would have accepted. A bounded
wait that then takes the agent's recommendation keeps work moving while
leaving the human the first say.

## What Changes

- A pending agent question in which **every** question has a recommended
  option (an option label ending with `(Recommended)`, the Claude Code
  convention) gets an auto-answer deadline: when the human has not answered
  by then, the server answers it with the recommended option(s).
- The wait is configurable from Settings (server-persisted, default
  5 minutes, `0` turns the feature off) and applies to every chat session
  whatever its approval policy; a change applies to questions asked after it.
- Questions with no recommended option (in any of their questions) keep
  today's behavior: they wait for the human indefinitely.
- The question card shows a countdown to the auto-answer and names the
  option(s) that will be chosen, plus a **Wait for me** control that cancels
  the deadline for that question, for every attached client. Selecting an
  option or typing in the form holds it the same way, so an answer the human
  has started is never replaced.
- Records the question-answer rule the `fix/question-other-answer` branch
  implements: a single-select answer is an option or the user's own text,
  never both; a multi-select answer adds the text as one more selection.
- The transcript marks an auto-answered question as answered by the timeout,
  distinct from a user's answer, and the answer returned to the agent says it
  was chosen automatically after no user answer.
- The deadline lives with the pending request: it is shown to clients that
  attach later and disappears with it. A server restart still cancels pending
  questions as today (no deadline is restored).
- Modifies the rule that the auto approval policy never answers questions:
  the policy still does not, but the timeout can.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-sessions`: question answers state the option-or-own-text rule;
  agent questions gain a recommended-option auto-answer
  after a configurable wait; the question form shows the deadline and a hold
  control; Settings gains the wait; the auto-policy requirement's statement
  about questions is narrowed to the policy itself.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts` (deadline timer per pending
  question, hold, settlement), `src/server/chat/contentBlocks.ts`
  (recommended-option detection), `src/server/chat/ChatSessionManager.ts` and
  `ChatConnections.ts` (setting plumbing, new `chat-question-hold` client
  message in `chatConnectionTypes.ts`), `src/server/routes/settings.ts`
  (`app_settings` key and route).
- Shared: `src/shared/chat.ts` (`question_request.autoAnswer`,
  `ChatRequestDecidedBy` gains `timeout`, a hold event, pending snapshot
  field), `src/shared/types.ts` for the settings message.
- Client: `ChatRequests.tsx` (countdown, Wait for me), `ChatMessages.tsx`
  (auto-answered marker), `SettingsModal.tsx` / settings store.
- Teams: an auto-answered question ends the session's `permission` status, so
  attention items, needs-attention badges, and mail held behind the pending
  request clear as they do after a human answer. No schema migration.
