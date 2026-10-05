# Tasks

## 1. Replacement decision and dependency alignment

- [ ] 1.1 Document a reproducible SDK limitation or measured dependency/runtime benefit, compare supported SDK options and narrow patch/upstream extension with full replacement, and record an explicit decision before transport implementation; verify a decision note contains evidence and scope, retaining the SDK if replacement is not justified.
- [ ] 1.2 Confirm the base chat integration is complete and reconcile SDK-specific wording in the base/profile change artifacts through the update workflow without changing user-facing acceptance criteria; verify dependency order and launch contract are documented consistently before archive.

## 2. Runtime contract and availability

- [ ] 2.1 Add local conversation/wire types and injectable process/conversation factories; verify TypeScript checks and driver fixture tests compile without importing SDK types in the new modules.
- [ ] 2.2 Implement KAWAI_CLAUDE_PATH/PATH resolution, bounded version probe, baseline 2.1.289 enforcement, and creation-time availability checks; verify tests cover missing/non-executable paths, explicit override, probe timeout, unsupported version, no persistence on refusal, and unaffected terminal startup.
- [ ] 2.3 Implement typed cwd/env/model/settings/resume launch arguments with default permissions and normal project context; verify argument-array tests cover dash-leading resume values, environment isolation, CLAUDECODE removal, settings sources, and absence of bypass/bare flags.
- [ ] 2.4 Document standalone CLI installation, tested version, executable selection, authentication inheritance, and runtime errors; verify documented executable checks run and configuration names match tests.

## 3. Streaming transport and controls

- [ ] 3.1 Implement UTF-8 JSON-line framing and envelope validation with frame/stderr bounds; verify tests cover split Unicode, CRLF, multi-line chunks, unterminated final line, diagnostic lines, malformed known frames, additive unknown fields, and oversized frames.
- [ ] 3.2 Implement concurrent stdout reading, serialized backpressured writes, initialization gating, correlated responses, deadlines, and persistent input; verify fake-child tests cover response reordering, init rejection/timeout, writes before init, broken pipes, two turns, and EOF with pending controls.
- [ ] 3.3 Bridge can_use_tool and AskUserQuestion to existing pending requests, returning original or updatedInput and handling control_cancel_request; verify tests cover allow/deny, answer validation, first-answer-wins, cancellation while answering, stale responses, and unsupported request failure without approval.
- [ ] 3.4 Implement interrupt and bounded shutdown/terminate/kill/reaping with idempotent settlement; verify tests cover pending approvals, queued writes, stalled initialization, unresponsive children, backend shutdown, and absence of leaked processes.
- [ ] 3.5 Document consumed protocol envelopes, timeout/buffer defaults, unsupported features, and fixture provenance; verify examples match transport tests and reference the inspected upstream commit/runtime.

## 4. Driver and manager replacement

- [ ] 4.1 Switch ChatSessionDriver and TurnQueue to the local conversation interface, preserving event mapping and queue semantics; verify existing parity tests cover deltas/final text, tool events, echo suppression, status, two turns, recoverable errors including is_error with success subtype, crash recovery, and late events after interrupt.
- [ ] 4.2 Replace manager SDK import with the runtime factory and actionable CLI errors; retain sdkSessionId storage, lazy first send, transcript replay, and resume; verify manager tests cover racing sends, immediate ID persistence, old records, failed resume, missing transcript, kill, restart, and process cleanup.
- [ ] 4.3 Preserve profile-compatible env/model/inline-settings launch inputs and adapt already-applied profile integration if present; verify configuration isolation and conflicting-settings precedence against a local mock endpoint without live provider calls.
- [ ] 4.4 Remove SDK imports/dependency and regenerate the Bun lockfile after adapter parity; verify repository searches find no active SDK imports, bun install succeeds, and typecheck plus chat tests pass without the SDK installed.
- [ ] 4.5 Update README and CLAUDE.md architecture/setup descriptions and rollback guidance; verify no instruction implies a bundled runtime and persisted conversation fields remain compatible.

## 5. Integration acceptance

- [ ] 5.1 Run the installed CLI against a local mock Anthropic endpoint with temporary configuration; verify successive turns, approval allow/deny, AskUserQuestion, cancellation, interrupt, process cleanup, and resume of a fixture conversation created with the prior SDK, retaining observed results and no credentials.
- [ ] 5.2 Use the dev-browser skill for chat regression verification, searching for it if absent and reporting its absence before using Playwright fallback; verify transcript streaming, approval/question cards, two-client resolution, reconnect, stop, restart/resume, and kill with screenshots and DOM assertions.
- [ ] 5.3 Run bun run lint && bun run typecheck && bun run test and strict OpenSpec validation; verify all required checks pass or record actionable blockers before declaring implementation complete.
