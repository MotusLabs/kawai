# Proposal

## Why

Every Kawai chat session, and so every team member, is Claude Code. When the shared Claude login cools down, the lead and the devs stall together, and the team has no second model family to fall back on. Codex has a supported client protocol (`codex app-server`, JSON-RPC over stdio) that covers what a Kawai chat needs: streamed items, approval and question requests, interrupts, usage and rate-limit data, and client-defined tools. Codex is installed on this host. The 2026-10-05 chat design already planned for a Codex driver behind the chat boundary. The goal of this change is Codex as a full team member, not a standalone chat.

## What Changes

- **A runtime interface for chat drivers.** The session manager, mailbox, and turn queue depend on a runtime-neutral driver contract instead of the concrete Claude `ChatSessionDriver`. Claude behavior does not change.
- **A Codex app-server driver.** Each Codex chat runs its own `codex app-server` child over stdio JSON-RPC. Kawai never attaches to an installed app-server daemon. The driver starts or resumes a thread, runs turns, streams agent text and reasoning, interrupts with `turn/interrupt`, and maps Codex items onto the existing `ChatEvent`, activity, context-usage, and status contracts. Protocol types are generated from a pinned Codex version, and a version gate refuses older executables before a session is created. `@openai/codex-sdk` is not used: it wraps `codex exec`, and that path cannot raise approval or question requests.
- **Approvals and questions keep Kawai's cards.**
  - Both approval policies run the same sandbox: `workspace-write`, network on, and the repository's git common directory added as a writable root so commits from linked worktrees work. Codex starts and resumes with `approvalPolicy: on-request` and `approvalsReviewer: user` under both Kawai policies, so escalations reach Kawai regardless of the Codex home's reviewer setting.
  - Under manual, each Codex escalation (`commandExecution`, `fileChange`, or `permissions`) becomes an allow/deny card; allow maps to `accept`, deny to `decline`.
  - Under auto, Kawai accepts each escalation itself.
  - `item/tool/requestUserInput` becomes a question card and is never answered automatically.
  - Toggling the policy live never restarts the thread.
- **Codex team members.**
  - The `kawai-team` tools (mailbox, tasks, strategy, mailbox management, `release_member`) are registered as Codex `dynamicTools` under a `kawai-team` namespace. Codex calls them back over the session's own pipe, and they run through the existing session-bound handlers.
  - A thread that rejects them refuses to start, so a Codex member never runs without its team tools.
  - Role and team context arrive as `developerInstructions`.
  - Mail receipts are read from the Codex rollout file.
  - Groups spawn Codex members through `profile: <codex-profile>`.
- **Runtime on the profile.** A catalog entry may declare `runtime: "codex"` with Codex fields: model, `codexHome` (default `~/.codex`), and network. Each runtime has its own field allowlist. `codexHome` and `network` are trusted-tier fields: like `executable`, only the shipped default and the user level set them, and a project file setting either is rejected with that file's error. A Codex profile cannot be declared as a model of a providers.json provider. The runtime, and for Codex the resolved Codex home, are stored on the chat row at creation and reused on resume, so a profile edit never moves an existing chat to another driver or home; a mismatch refuses the start. Kawai never writes into a Codex home: it passes only `CODEX_HOME` and `-c` overrides.
- **Codex limits and usage.**
  - Codex usage-limit, rate-limit, and overload failures feed `profile_limit_events`, so Codex members park, release, or forward through the existing limit outcomes.
  - A login-wide limit event is recorded once against the Codex home's provider (`codex-home-<first 12 hex of sha256 of the resolved home>`), so every profile on that home cools down together through the shared cooldown; no per-profile copies are written. A limit on one session's own budget cools only that session's profile. When multiple applicable quota windows are exhausted, the cooldown and parked-work resume use the latest known reset among them.
  - The usage bar shows Codex rate-limit windows, kept per Codex home.

Non-goals:
- Routing rules or strategies that deliberately send work to Codex while Claude is cooling down.
- More than the one Codex login per home that `codexHome` allows.
- An "allow for session" approval button.
- A model picker.
- Fixing the shared-login cooldown gap for Claude profiles.
- Steering in-flight turns with `turn/steer`.
- A shared multi-chat app-server.
- Changing terminal-session Codex support.

## Capabilities

### New Capabilities

- `codex-chat-sessions`: Codex as a chat and team-member runtime. Covers the separately installed and version-gated Codex executable and the app-server transport. Covers thread start, resume, and replay; streaming and activity; approval and question mapping under one sandbox; the team tools as dynamic tools; rollout-based mail receipts; and Codex usage and account state.

### Modified Capabilities

- `claude-session-profiles`: catalog entries may declare a runtime. Codex entries have their own allowlisted fields, including the trusted-tier `codexHome` and `network`, and the chat profile picker offers Codex profiles beside Claude ones.
- `chat-usage-limits`: Codex rate-limit windows feed the usage bar, kept per Codex home and shared by every profile on that home.
- `profile-limit-handling`: Codex limit failures are recorded as limit events; a login-wide one names the Codex home's provider and cools every profile on that home through the shared cooldown, with no per-profile copies.

## Impact

- **Server, new files:**
  - `src/server/chat/provider/` holds the driver contract and the factory that picks a driver from the stored runtime.
  - `src/server/chat/codex/` contains:
    - `appServerClient.ts`: JSON-RPC over stdio, requests, notifications, and server requests.
    - `CodexSessionDriver.ts`: thread lifecycle, turns, interrupt, approvals, and questions.
    - `codexEvents.ts`: pure item and notification to `ChatEvent`/activity mapping.
    - `codexTools.ts`: dynamic tool specs from the existing Zod schemas, plus call dispatch.
    - `codexExecutable.ts`: resolution and version gate.
    - `codexSandbox.ts`: sandbox, writable roots, and network.
    - `codexRollout.ts`: rollout parsing for receipts and archived replay.
    - `codexLimits.ts` and `codexUsage.ts`.
  - Generated protocol types are vendored under `src/server/chat/codex/protocol/` with the generating version recorded.
- **Server, modified files:**
  - `ChatSessionDriver.ts` implements the contract.
  - `ChatSessionManager.ts` chooses the driver by runtime, and adds the Codex executable and auth checks, usage, and notices keyed by Codex home. Its transcript tail confirms Codex mail receipts live from the rollout file.
  - `TurnQueue.ts` and `team/sessionMailbox.ts` drop their Claude SDK types.
  - `team/mailboxTools.ts` exposes a runtime-neutral tool table beside the Claude MCP server.
  - `team/receipt.ts` takes a receipt-row parser per runtime.
  - `profileCatalog.ts` and `ClaudeProfiles.ts` gain per-runtime entries.
  - `limitSignals.ts` and `usageLimits.ts` gain Codex inputs.
  - `team/routing/handoff.ts` reads every path of a multi-file change into the handoff digest.
  - `logPoller.ts` adds Codex thread ids to the chat exclusion set.
- **Data:** an additive `runtime` column on `chat_sessions` (default `claude`) and nullable `codex_home` and `transcript_path` columns. The existing `sdk_session_id` holds the Codex thread id.
- **Client:** profile options carry their runtime. The New Session dialog and chat header label Codex profiles. The usage bar labels Codex windows. The Debug panel labels Codex JSON-RPC frames by method. No new controls.
- **Dependencies:** none added. A Codex CLI at or above the pinned baseline (0.163.0) must be installed on the host (`KAWAI_CODEX_PATH` or `codex` on `PATH`) only for Codex profiles.
- **Docs:** CLAUDE.md "How It Works" gets bullets for Codex chats, Codex profiles, and Codex limits. `docs/routing/README.md` gets a note that Codex profiles are ordinary profile ids.
- **Tests:**
  - Unit tests for the event mapping, tool dispatch, sandbox assembly, rollout receipts, limit recording, and catalog validation.
  - A scripted fake app-server for driver tests.
  - A fixture e2e spec for a Codex chat's approval card and peer turn, named in `ci.yml`.
