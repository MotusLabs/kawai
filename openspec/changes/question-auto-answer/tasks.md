# Tasks

## 1. Shared contracts and detection

- [ ] 1.0 Confirm `fix/question-other-answer` (one choice per single-select answer, own text appended for multi-select) is merged into the base branch; verify `validateAnswers` refuses option-plus-text for single-select

- [ ] 1.1 In `src/shared/chat.ts` add `autoAnswer?: { at: string; answers: Record<string, ChatQuestionAnswer> }` to `question_request` and the pending `question` snapshot, `'timeout'` to `ChatRequestDecidedBy`, optional `answers?: Record<string, string>` on `request_resolved`, and the `question_auto_answer_held { requestId }` event; verify `bun run typecheck` passes and existing chat event tests still pass
- [ ] 1.2 Add `recommendedAnswers(questions)` beside `parseQuestions` in `src/server/chat/contentBlocks.ts` (D1: every question must mark one, case-insensitive trailing `(Recommended)`, first for single-select, all for multi-select, labels verbatim); verify with unit tests for all-marked, one-unmarked, multi-select, case/whitespace variants, and a marker mid-label not matching

## 2. Driver deadline, settlement, and hold

- [ ] 2.1 Add the `getQuestionAutoAnswerMs` driver option and, in `canUseTool`, set the deadline and timer when D1 yields answers and the wait is positive, emitting `autoAnswer` on `question_request` and in `getPendingRequests`; verify with driver tests (fake timers) that a marked question gets `autoAnswer.at` = request time + wait and an unmarked one or a 0 wait gets none
- [ ] 2.2 Implement timer settlement through `validateAnswers` with the D3 `response` note, `request_resolved` `{ outcome: 'answered', decidedBy: 'timeout', answers }`, and `refreshStatus`; clear the timer in `answerQuestion`, `cancelRequest`, kill, and shutdown; verify tests: deadline answers with the recommended labels and note, a user answer before it wins and no second settlement occurs, interrupt/kill before it sends nothing, status leaves `permission`
- [ ] 2.3 Add `holdQuestion(requestId)` (D4) refusing unknown, settled, non-question, or deadline-less requests and otherwise clearing the timer, dropping `autoAnswer`, and emitting `question_auto_answer_held`; verify tests for refusal cases, that a held question never auto-answers, and that a later user answer still works

## 3. Setting and server plumbing

- [ ] 3.1 Add the `question_auto_answer_minutes` `app_settings` key (default 5, integers 0–1440) with a boot read and `GET`/`PUT /api/settings/question-auto-answer` using the persist-then-apply rollback and a broadcast; verify route tests for default, save, restart read, and refusal of 1441, -1, and 2.5 with nothing stored
- [ ] 3.2 Pass `getQuestionAutoAnswerMs` from `ChatSessionManager` to every driver it constructs (first start, resume, respawn) reading the live setting; verify a manager test that a changed setting applies to the next question and leaves a pending deadline unchanged
- [ ] 3.3 Add `chat-question-hold` to `CHAT_CONNECTION_TYPES` and handle it in `ChatConnections` via the manager, answering errors to the requester; verify a connections test that a hold reaches every attached client and a stale id returns an error

## 4. Client

- [ ] 4.1 In `ChatRequests.tsx` show "Will choose <labels> in m:ss" from `autoAnswer.at` and a **Wait for me** button (disabled while disconnected) sending `chat-question-hold`, and send the same hold once on the form's first edit (option or text) while a deadline stands; apply `question_auto_answer_held` in the chat store to drop `autoAnswer`; verify component and store tests for the countdown, the button message, exactly one hold on the first edit and none without a deadline, and removal on the held event
- [ ] 4.2 In `ChatMessages.tsx` render `decidedBy: 'timeout'` as "Answered automatically: <labels>" and the held event as "Auto-answer held"; verify a render test distinguishing user, policy, and timeout resolutions
- [ ] 4.3 Add the minutes field to `SettingsModal.tsx` and the settings store with inline refusal and live update from the broadcast; verify settings modal/store tests for load, save, refusal, and 0 shown as off

## 5. Documentation and integration

- [ ] 5.1 Update the chat sessions bullets in `AGENTS.md` (questions, auto policy) to describe the deadline, hold, setting, and that the auto policy still never answers questions; verify `bun run test` passes (docs read by tests)
- [ ] 5.2 Verify end to end against the development fixture or a real chat: a question with a `(Recommended)` option and a 1-minute wait is answered automatically with the transcript marker and agent note, and Wait for me in a second browser stops it in both
