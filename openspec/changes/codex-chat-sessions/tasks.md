# Tasks

## 1. Spike against the Codex baseline

- [ ] 1.1 Write `scripts/codex-smoke.ts` against the installed Codex app-server. It covers `initialize` with `experimentalApi`, `thread/start` with a `kawai-team` dynamic-tool namespace and the D5 sandbox config, a dynamic tool call, a command approval round-trip, `requestUserInput`, `turn/interrupt`, and `thread/resume` in a second process. Verify by running it locally and saving its JSON-RPC transcript under `src/server/chat/codex/__fixtures__/`.
- [ ] 1.2 Answer every design Open Question from the smoke run:
  - dynamic-call approval and timeout
  - tool restoration on resume
  - `.git` writability under the writable root
  - localhost binding in the sandbox
  - replay shapes in `thread/read` and the rollout file
  - the retry signal

  Record the answers in design.md (replace Open Questions with a "Spike results" section). Verify the design has no remaining open question.

## 2. Provider-neutral driver contract (no behavior change)

- [ ] 2.1 Add `src/server/chat/provider/driver.ts` with `ChatAgentDriver` and `ChatDriverCallbacks` (design D1). Make `ChatSessionDriver` implement it. Verify `bun run typecheck` passes and the existing driver tests pass unmodified.
- [ ] 2.2 Make `TurnQueue` generic, and type `team/sessionMailbox.ts` `getDriver` and `ChatSessionManager`'s driver map as `ChatAgentDriver`. Move the Claude-only extras behind optional capability methods. Verify the existing mailbox, manager, and chat tests pass unmodified.
- [ ] 2.3 Add `createChatDriver(record, deps)` choosing the driver by provider, with only Claude wired. Verify with a unit test that a `claude` record builds a `ChatSessionDriver` and an unknown provider throws.
- [ ] 2.4 Extract `teamToolTable(mailbox, sessionId, services)` from `team/mailboxTools.ts` and rebuild `createMailboxServer` on it. Verify the existing team-tool tests pass, and a new test shows the table and the MCP server expose the same tool names.

## 3. Profiles and persistence

- [ ] 3.1 Extend `profileCatalog.ts` with `provider` and the per-provider field sets (`codex`: `label`, `model`, `codexHome`, `network`). Enforce the user-level-only `codexHome` rule and reject provider conflicts across levels. Verify unit tests for every scenario in the `claude-session-profiles` delta.
- [ ] 3.2 Resolve profiles to the provider union. Add `codexProfiles.ts` that builds the Codex spawn env (`CODEX_HOME`, default `~/.codex` or the server's `CODEX_HOME`). Verify with unit tests, including that no Codex home or env reaches the profiles route payload.
- [ ] 3.3 Add `provider` (default `claude`) and `transcript_path` columns to `chat_sessions` with an additive migration. Write `provider` at creation and refuse to start on a provider mismatch. Verify with `db.test.ts` migration coverage and a manager test for the legacy-chat and mismatch scenarios.
- [ ] 3.4 Send each profile's provider to the client. Label Codex profiles in the New Session dialog and chat header. Verify with a client test and `tests/e2e/chat-profiles.spec.ts` showing a Codex profile option.

## 4. Codex executable and app-server client

- [ ] 4.1 Vendor `generate-ts --experimental` output for the baseline under `src/server/chat/codex/protocol/` with a `VERSION` file. Verify `bun run typecheck` and that lint ignores the generated folder.
- [ ] 4.2 Add `codexExecutable.ts`: `KAWAI_CODEX_PATH` or `PATH` resolution, no shell, bounded `--version` gate, cache keyed by path and mtime. Wire it into Codex chat creation, and add the Codex login check per home. Verify unit tests for every scenario in the executable, version, and login requirements of the `codex-chat-sessions` spec.
- [ ] 4.3 Add `appServerClient.ts`: spawn, newline-delimited JSON-RPC framing, request and response correlation, notification and server-request routing, wire-log recording, and process-end handling. Verify with unit tests against a scripted fake child, including a torn line and a child exit with pending requests.
- [ ] 4.4 Add a fake app-server (`tests/fixtures/fake-codex-app-server.ts`, an executable bun script) that replays the recorded transcripts from 1.1. Verify that the client tests and a smoke test spawn it through `KAWAI_CODEX_PATH`.

## 5. Codex driver core

- [ ] 5.1 Add `codexEvents.ts` (design D7): a pure mapping from Codex notifications and items to `ChatEvent` and `ChatActivityInput`, with user-echo suppression. Verify with table tests from the recorded transcripts for streaming, command, file change, tool calls, token usage, and a failed turn.
- [ ] 5.2 Add `CodexSessionDriver` implementing `ChatAgentDriver`:
  - thread start and resume, storing the thread id and `Thread.path` (`onSdkSessionId`, `onTranscriptPath`)
  - `send`/`deliver` through `turn/start`
  - status derivation
  - `turn/interrupt` with request cancellation
  - respawn on process end

  Verify the driver tests against the fake app-server for the persistence, resume, streaming, activity, and interrupt scenarios.
- [ ] 5.3 Add `codexSandbox.ts` (design D5): `workspace-write`, the git common dir writable root (absolute; none outside a repository), and network from the profile. Verify unit tests for main checkout, linked worktree, non-repository, and `network: false`.
- [ ] 5.4 Set `approvalsReviewer: "user"` explicitly on thread start and resume under both Kawai policies, overriding the Codex home's reviewer configuration. Map approval and question server requests to cards under manual, and accept them automatically under auto, reading the policy per request. Answers return keyed by question id. Verify driver tests for the manual, auto, live-switch, and question-under-auto scenarios, plus start and resume under both policies with a Codex home configured for `auto_review`: assert the reviewer override and that Kawai owns the escalation decision.
- [ ] 5.5 Pass `developerInstructions` from `getSystemPromptAppend` at start and resume, and the group effort as `turn/start.effort`. Verify a driver test asserting both, and a spawn test showing a Codex member's first turn is the task mail.
- [ ] 5.6 Wire `createChatDriver` for `codex` in `ChatSessionManager`. Verify a manager test that creates, attaches, sends, archives, restores, and kills a Codex chat against the fake app-server.

## 6. Team tools, receipts, and replay

- [ ] 6.1 Add `codexTools.ts` (design D6): a `kawai-team` namespace spec built from `teamToolTable` with `z.toJSONSchema`, plus `item/tool/call` dispatch with thread and namespace checks and Zod validation. Refuse to start when registration is rejected. Verify unit tests for a good call, a foreign thread, unknown tool, invalid arguments, and the refused-registration scenario.
- [ ] 6.2 Make `team/receipt.ts` take a per-provider row parser. Add `codexReceiptMessageId`, and have `transcriptFor` return `transcript_path` for Codex chats. Verify receipt tests for a found envelope, an AGENTS.md user row that must not match, a torn file, and startup reconciliation with no running agent.
- [ ] 6.3 Add `codexRollout.ts` for replay of archived chats, and use `thread/read` when a driver is live. Skip the title watcher for Codex chats. Verify replay tests from a recorded rollout and the archived-chat scenario (no process spawned).
- [ ] 6.4 Have the Codex log matcher honor `excludeSessionIds` against `session_meta.id`. Verify a log-poller test showing a chat's Codex rollout never becomes a terminal session.
- [ ] 6.5 Document Codex chats and Codex profiles in CLAUDE.md "How It Works":
  - provider on the profile, `codexHome`, `KAWAI_CODEX_PATH` and the baseline
  - the one sandbox and what manual means for Codex
  - team tools as dynamic tools
  - rollout receipts

  Verify the bullets match the implemented behavior.

## 7. Usage and limits

- [ ] 7.1 Add `codexUsage.ts`: normalize `RateLimitSnapshot` to `ChatUsageReport` with duration and name labels and the limited status. Cache per resolved Codex home, and fill in with `account/rateLimits/read`. Verify unit tests for the `chat-usage-limits` delta scenarios and a `UsageBar` test showing the Codex labels.
- [ ] 7.2 Add `codexLimits.ts`: map `codexErrorInfo` limit classes to final signals and retries to non-final ones, taking the latest known reset among all applicable exhausted windows in the latest snapshot (ignoring non-exhausted windows). In the manager, fan out each event to every Codex profile on the same home. Verify unit tests for the `profile-limit-handling` delta scenarios, including a park and a forward that avoids the shared login. Cover simultaneous five-hour and weekly exhaustion: the event, shared-home cooldown, and parked-work resume all use the later reset. Also cover a non-exhausted weekly window with a later reset, which must not extend the cooldown.
- [ ] 7.3 Document Codex limits and usage in CLAUDE.md (usage keyed per home, cooldown fan-out) and in `docs/routing/README.md` (Codex profiles are ordinary profile ids). Verify the docs name the same behaviors the tests cover.

## 8. Integration checks

- [ ] 8.1 Add `tests/e2e/chat-codex.spec.ts` using the fake app-server through `KAWAI_CODEX_PATH`. Cover creating a Codex chat, a manual approval card round-trip, a question card, and a peer-message turn. Name it in `ci.yml`'s fixture run. Verify it passes locally and in CI.
- [ ] 8.2 Run `scripts/codex-smoke.ts` and a manual team run against real Codex: a group with a Codex `profile` spawns a member in a worktree, the member commits and replies through `kawai-team`, and the receipt settles. Record the result in the change's journal or PR. Verify the reply reaches the lead and the message shows delivered.
- [ ] 8.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate codex-chat-sessions --strict`. Verify all pass.

## Workflow follow-up

- Archive the change after review and merge.
