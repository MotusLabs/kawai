# Tasks

## 1. Spike against the Codex baseline

- [x] 1.1 Write `scripts/codex-smoke.ts` against the installed Codex app-server. It covers `initialize` with `experimentalApi`, `thread/start` with a `kawai-team` dynamic-tool namespace and the D5 sandbox config, a dynamic tool call, a command approval round-trip, `requestUserInput`, `turn/interrupt`, and `thread/resume` in a second process. Verify by running it locally and saving its JSON-RPC transcript under `src/server/chat/codex/__fixtures__/`.
- [x] 1.2 Answer every design Open Question from the smoke run:
  - dynamic-call approval and timeout
  - tool restoration on resume
  - `.git` writability under the writable root
  - localhost binding in the sandbox
  - replay shapes in `thread/read` and the rollout file
  - the retry signal
  - the scope of `sessionBudgetExceeded` (session, thread, or account)

  Record the answers in design.md (replace Open Questions with a "Spike results" section). Verify the design has no remaining open question.

## 2. Provider-neutral driver contract (no behavior change)

- [x] 2.1 Add `src/server/chat/provider/driver.ts` with `ChatAgentDriver` and `ChatDriverCallbacks` (design D1), including the background-task methods the manager calls (`getBackgroundTaskRecords`, `getTaskOutput`, `stopTask`). Make `ChatSessionDriver` implement it. Verify `bun run typecheck` passes and the existing driver tests pass unmodified.
- [x] 2.2 Make `TurnQueue` generic, and type `team/sessionMailbox.ts` `getDriver` and `ChatSessionManager`'s driver map as `ChatAgentDriver`. Move the Claude-only extras behind optional capability methods. Verify the existing mailbox, manager, and chat tests pass unmodified, the background-task roster, `chat-task-output`, and `chat-task-stop` tests included.
- [x] 2.3 Add `createChatDriver(record.runtime, deps)` choosing the driver by runtime, with only Claude wired. Verify with a unit test that a `claude` record builds a `ChatSessionDriver` and an unknown runtime throws.
- [x] 2.4 Extract `teamToolTable(mailbox, sessionId, services)` from `team/mailboxTools.ts` and rebuild `createMailboxServer` on it. Build on master after `task-results-handoffs` (PR #136) merges, so its result, handoff, and findings tools are in the table. Verify the existing team-tool tests pass, and a new test shows the table and the MCP server expose the same tool names.

## 3. Profiles and persistence

- [x] 3.1 Extend `profileCatalog.ts` with `runtime` and the per-runtime field sets (a `codex` entry: `label`, `model`, `codexHome`, `network`). Enforce the trusted-tier `codexHome` and `network` rule (shipped default and user level only, like `executable`) and reject runtime conflicts across levels. Verify unit tests for every scenario in the `claude-session-profiles` delta.
- [x] 3.2 Resolve profiles to the runtime union. Add `codexProfiles.ts` that builds the Codex spawn env: the server environment minus the provider variables (every `ANTHROPIC_*`/`CLAUDE_CODE_*` and `AGENTBOARD_CHAT_ENV`), plus `CODEX_HOME` at the resolved home (design D4, review B2). Verify with unit tests, including that no Codex home or env reaches the profiles route payload, and that the spawn writes nothing into the home.
- [x] 3.3 Add `runtime` (default `claude`), `codex_home`, and `transcript_path` columns to `chat_sessions` with an additive migration. Write `runtime` and, for Codex chats, the resolved home at creation. Refuse to start on a runtime or Codex home mismatch, without naming the home. Verify with `db.test.ts` migration coverage and manager tests for the legacy-chat, runtime-mismatch, and home-mismatch scenarios.
- [x] 3.4 Send each profile's runtime to the client. Label Codex profiles in the New Session dialog and chat header. Verify with a client test and `tests/e2e/chat-profiles.spec.ts` showing a Codex profile option.

## 4. Codex executable and app-server client

- [x] 4.1 Vendor `generate-ts --experimental` output for the baseline under `src/server/chat/codex/protocol/` with a `VERSION` file. Verify `bun run typecheck` and that lint ignores the generated folder.
- [x] 4.2 Add `codexExecutable.ts`: `KAWAI_CODEX_PATH` or `PATH` resolution, no shell, bounded `--version` gate, cache keyed by path and mtime. Wire it into Codex chat creation, and add the Codex login check per home. Verify unit tests for every scenario in the executable, version, and login requirements of the `codex-chat-sessions` spec.
- [x] 4.3 Add `appServerClient.ts`: spawn, newline-delimited JSON-RPC framing, request and response correlation, notification and server-request routing, wire-log recording, and process-end handling. Verify with unit tests against a scripted fake child, including a torn line and a child exit with pending requests.
- [x] 4.4 Add a fake app-server (`tests/fixtures/fake-codex-app-server.ts`, an executable bun script) that replays the recorded transcripts from 1.1. Verify that the client tests and a smoke test spawn it through `KAWAI_CODEX_PATH`.
- [x] 4.5 Label JSON-RPC frames in `src/client/utils/chatWireFrames.ts` by `method`, or `response #<id>` / `error #<id>`, and name the chat's runtime in the Debug panel's direction labels. Verify `chatWireFrames.test.ts` cases for a request, a notification, a response, an error, and an unchanged Claude frame.

## 5. Codex driver core

- [x] 5.1 Add `codexEvents.ts` (design D7): a pure mapping from Codex notifications and items to `ChatEvent` and `ChatActivityInput`, with user-echo suppression. Verify with table tests from the recorded transcripts for streaming, command, file change, tool calls, token usage, and a failed turn. Include a file change touching two paths, whose input names both. Extend `ProgressDigest` to read a `paths` array, and verify with a handoff test that a forwarded Codex member's digest lists both files.
- [x] 5.2 Add `CodexSessionDriver` implementing `ChatAgentDriver`:
  - thread start and resume, storing the thread id and `Thread.path` (`onSdkSessionId`, `onTranscriptPath`)
  - `send`/`deliver` through `turn/start`
  - status derivation
  - `turn/interrupt` with request cancellation
  - respawn on process end
  - `onCompaction` from the mapped `contextCompaction` item, and `onContextUsage`'s `thresholdSource` — both optional callbacks, so without them a Codex chat only misses process observability

  Verify the driver tests against the fake app-server for the persistence, resume, streaming, activity, and interrupt scenarios.
- [x] 5.3 Add `codexSandbox.ts` (design D5): `workspace-write`, the git common dir writable root (absolute; none outside a repository), and network from the profile. Verify unit tests for main checkout, linked worktree, non-repository, and `network: false`.
- [x] 5.4 Set `approvalsReviewer: "user"` explicitly on thread start and resume under both Kawai policies, overriding the Codex home's reviewer configuration. Map approval and question server requests to cards under manual, and accept them automatically under auto, reading the policy per request. Answers return keyed by question id. Verify driver tests for the manual, auto, live-switch, and question-under-auto scenarios, plus start and resume under both policies with a Codex home configured for `auto_review`: assert the reviewer override and that Kawai owns the escalation decision.
- [x] 5.5 Pass `developerInstructions` from `getSystemPromptAppend` at start and resume, and the group effort as `turn/start.effort`. Verify a driver test asserting both, and a spawn test showing a Codex member's first turn is the task mail.
- [x] 5.6 Wire `createChatDriver` for `codex` in `ChatSessionManager`. Verify a manager test that creates, attaches, sends, archives, restores, and kills a Codex chat against the fake app-server.
- [x] 5.7 Outbound-audit parity (design D13, ruling R5): feed every `commandExecution` item (as `Bash`) and every external `mcpToolCall` (as `mcp__<server>__<tool>`) to the session's `OutboundObserver` — start, completion, failure, a declined approval, and the process end — observation only, inside try/catch. `kawai-team` dynamic-tool calls and `fileChange` items are never fed. `developerInstructions` carries `SECURITY_NOTE_BODY` through `getSystemPromptAppend`. Verify driver tests that fail when the feed is removed, when a `kawai-team` call is fed, or when a `fileChange` is fed; that a throwing observer leaves the turn running; and a manager test that a Codex command lands an `outbound_calls` row.
- [x] 5.8 Honor the question answer-shape flags (archive review findings-98a0ecd9 F3): carry `isOther` and `isSecret` from the blocking `requestUserInput` question into optional `ChatQuestion` fields. On the question card, free text is offered where Codex allows another answer (absent keeps it, as on every Claude question) and always when the question offers no options, since text is then its only answer, and the input is masked where Codex marks the question secret, the answered card included. Verify driver tests carrying the flags (and leaving a sender's omitted flags absent, and the protocol's `options: null` mapping to `[]`) and client tests for the masked input before and after the answer, the gated free text with options, the no-options rule, and an unchanged Claude question.

## 6. Team tools, receipts, and replay

- [x] 6.1 Add `codexTools.ts` (design D6): a `kawai-team` namespace spec built from `teamToolTable` with `z.toJSONSchema`, plus `item/tool/call` dispatch with thread and namespace checks and Zod validation. Refuse to start when registration is rejected. Verify unit tests for a good call, a foreign thread, unknown tool, invalid arguments, and the refused-registration scenario.
- [x] 6.2 Make `team/receipt.ts` take a per-runtime row parser. Add `codexReceiptMessageId`, and have `transcriptFor` return `transcript_path` for Codex chats. Keep the live receipt tail for Codex chats: it follows `transcript_path` and parses rows with `codexReceiptMessageId`. Verify receipt tests for a found envelope, an AGENTS.md user row that must not match, a torn file, startup reconciliation with no running agent, and pushed mail that settles delivered while the turn still runs. A Codex receipt reads every rollout of the thread (`transcript_path` plus a bounded walk of `<codex_home>/sessions`, at most four levels, no symlinks) through one reader that the startup reconcile and the turn-end settle share; absence requeues only when the reader is proven and `transcript_path` is named for the thread, and otherwise holds (decision 2, M1–M2).
- [x] 6.3 Add `codexRollout.ts` for replay from the rollout alone — the one replay source for live and archived chats; `thread/read` is not used (`includeTurns` is deprecated on 0.163.0; decision 2, M3, with the paginated fallback a follow-up needing 8.2 evidence). Replay emits the turn boundaries a live turn emits, `turn_completed` included, under ids that change when a row is rewritten under the same path, and an unreadable rollout shows the history-unavailable notice without being memoized permanently. Skip only the title half of the transcript watcher for Codex chats. Verify replay tests from a recorded rollout (turn boundaries included), the archived-chat scenario (no process spawned), a rewrite making an older `beforeId` stale, and the unreadable-then-readable retry showing no duplicated turns.
- [x] 6.4 Have the Codex log matcher honor `excludeSessionIds` against `session_meta.id`. Verify a log-poller test showing a chat's Codex rollout never becomes a terminal session.
- [x] 6.5 Document Codex chats and Codex profiles in CLAUDE.md "How It Works":
  - runtime on the profile, `codexHome`, `KAWAI_CODEX_PATH` and the baseline
  - the one sandbox and what manual means for Codex
  - team tools as dynamic tools
  - rollout receipts

  Verify the bullets match the implemented behavior.

## 7. Usage and limits

- [x] 7.1 Add `codexUsage.ts`: normalize `RateLimitSnapshot` to `ChatUsageReport` with duration and name labels and the limited status. Cache per resolved Codex home under its `codex-home-<first 12 hex of sha256>` provider id (R2/R3), and fill in with `account/rateLimits/read`. Verify unit tests for the `chat-usage-limits` delta scenarios and a `UsageBar` test showing the Codex labels.
- [x] 7.2 Add `codexLimits.ts`: map `codexErrorInfo` limit classes to final signals and retries to non-final ones, taking the latest known reset among all applicable exhausted windows in the latest snapshot (ignoring non-exhausted windows). In the manager, record each login-scoped event once with the session's home provider id — every profile on that home cools through the shared cooldown (providers D8 `cooldownFor`; no per-profile fan-out) — and record a session-scoped event (`sessionBudgetExceeded`, unless 1.2 shows it is account-wide) for the session's own profile only. Verify unit tests for the `profile-limit-handling` delta scenarios, including a park and a forward that avoids the shared login. Cover simultaneous five-hour and weekly exhaustion: the event, shared-home cooldown, and parked-work resume all use the later reset. Also cover a non-exhausted weekly window with a later reset, which must not extend the cooldown, and the session-budget scenario.
- [x] 7.3 Document Codex limits and usage in CLAUDE.md (usage keyed per home, the shared home cooldown through providers D8) and in `docs/routing/README.md` (Codex profiles are ordinary profile ids). Verify the docs name the same behaviors the tests cover.

## 8. Integration checks

- [x] 8.1 Add `tests/e2e/chat-codex.spec.ts` using the fake app-server through `KAWAI_CODEX_PATH`. Cover creating a Codex chat, a manual approval card round-trip, a question card, and a peer-message turn. Name it in `ci.yml`'s fixture run. Verify it passes locally and in CI.
- [x] 8.2 Run `scripts/codex-smoke.ts` and a manual team run against real Codex: a group with a Codex `profile` spawns a member in a worktree, the member commits and replies through `kawai-team`, and the receipt settles. Record the result in the change's journal or PR. Verify the reply reaches the lead and the message shows delivered. Capture one real rollout user row that carries a delivered envelope, and pin `codexReceipt.test.ts` to it: today the parser follows the documented RolloutLine shape and accepts both `input_text` and `text` blocks, and an unproven reader holds mail instead of requeueing it (PR D decision 2, M1).
- [x] 8.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate codex-chat-sessions --strict`. Verify all pass.

## Workflow follow-up

- Archive the change after review and merge.
