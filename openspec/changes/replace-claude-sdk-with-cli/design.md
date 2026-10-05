# Design

## Context

See proposal.md for motivation. The installed TypeScript SDK is 0.3.289. ChatSessionDriver owns streaming-input query(), event mapping, approval promises, interrupt, and crash recovery. ChatSessionManager dynamically imports query(), lazily constructs drivers, and persists sdkSessionId in SQLite. TurnQueue and driver/manager tests import SDK types. Transcript replay already reads Claude Code JSONL independently of the SDK.

Source analysis of the Python SDK at commit 9c69ce7aced5cdf2aa1ac86fe62e877b4962de8b shows JSON-line subprocess transport and a bidirectional control channel. Installed Claude Code 2.1.289 accepted an initialize request directly and returned success without an inference prompt. This establishes handshake feasibility only; approvals, inference, and resume need integration validation. The installed TypeScript SDK remains the reference for Kawai parity where it differs from Python.

The base chat integration and debug view are implemented; provider profiles are implemented in PR #15 and must be merged before this replacement is applied. This follow-up intentionally supersedes the SDK transport decision while preserving existing behavior. Reconcile SDK-specific wording in main specs when implementing the replacement; archived artifacts remain historical records. The replacement must preserve the profiles' env/model/inline-settings launch contract.

## Goals / Non-Goals

**Goals:** Keep CLI protocol concerns behind a small testable server adapter; preserve chat events and durable conversation identity; own process cleanup and permission cancellation; expose actionable runtime failures.

**Non-Goals:** Reimplement Claude Code, call undocumented model HTTP endpoints, extract authentication tokens, add Python, implement every SDK feature, or create provider-profile UI. In-process SDK MCP servers and SDK callback hooks are not currently configured by Kawai and are outside this adapter's initial interface; ordinary CLI-configured MCP servers and project hooks continue to load.

## Decisions

### 0. Prefer the existing SDK until replacement is justified

Current project code already depends on the SDK for precisely the features it needs. Keep that integration as the recommended default. Before applying transport work, produce a decision note with a reproducible SDK limitation or measured benefit and compare supported SDK configuration, a narrow SDK patch/upstream extension, and this replacement. A successful CLI handshake is feasibility evidence, not a replacement justification. If retaining the SDK wins, do not implement this replacement; propose only the concrete missing behavior separately.

Do not attach independent stdin writers or stdout readers to an SDK-owned child. A hybrid extension requires an exposed and verified single-owner transport/control integration; no such safe extension point has been established here. Full replacement is coherent only once Kawai intentionally accepts ownership of the whole consumed protocol.

### 1. Separate transport from chat behavior

Add small modules under src/server/chat/ for local wire types/validation, JSON-line framing, runtime resolution, and ClaudeCLITransport. Inject a process factory for transport tests and a narrow conversation factory for existing driver tests. Preserve the driver's approval/question validation and ChatEvent mapping. Convert TurnQueue to local user-message types. Keep each file below 500 lines; the current driver is already large, so extract mapping or request state as necessary.

A thin replacement for the consumed query interface limits churn without cloning the entire SDK public API. Keeping the SDK would avoid protocol maintenance but would not meet the dependency-removal objective. A new HTTP model client would lose Claude Code's engine and tools.

### 2. Explicit executable and compatibility baseline

Resolve a server-only KAWAI_CLAUDE_PATH executable override, otherwise claude from PATH. It is a path, never a shell command or provider wrapper. Use argument arrays with Bun.spawn. Establish Claude Code 2.1.289 as the initial tested baseline; reject older versions with a clear upgrade error and require successful initialize for newer versions rather than promising compatibility from a version number alone. Cache bounded version checks per executable and invalidate on launch failure.

Use a 60-second initialization deadline and bounded version probe. Creation checks executable availability and configured auth before persistence; first send performs the full handshake lazily. Initialization has no user prompt. A missing CLI affects chat availability, not terminal sessions or backend startup. No automatic installation/download is performed. The baseline is deliberately narrower than Python SDK's minimum 2.0.0 because only the current installed runtime has been verified.

### 3. Match current launch configuration

Launch with --input-format stream-json, --output-format stream-json, --verbose, --include-partial-messages, --permission-mode default, --permission-prompt-tool stdio, and --setting-sources user,project,local. Retain the CLI's normal Claude Code prompt rather than passing the Python SDK's empty --system-prompt; do not enable --bare because current chat sessions load project/user/local context. Bind resume as --resume=<id>.

Accept typed server launch options for cwd, copied env, optional model, and inline settings, allowing profile resolution to map to CLI flags later. Preserve inherited runtime/auth variables and CLAUDE_CONFIG_DIR; remove inherited CLAUDECODE as the SDK does. Do not impersonate SDK telemetry identity or rely on telemetry environment values for authentication. Do not use permission-bypass flags. Authentication remains delegated to the executable; preserve configured-auth checks without printing credentials.

### 4. Bidirectional protocol and persistent turns

Start one stdout reader and one serialized write queue per process. Record exact stdin/stdout lines, stderr, and lifecycle events through the existing ChatWireRecorder/ChatWireLogs contract, preserving sequence identity across respawns and the chat-debug WebSocket interface; capture at the transport boundary without adding competing readers or writers. Send {type: control_request, request_id, request: {subtype: initialize, hooks: null}}, await the matching success response, then release queued user messages. Route control responses by request ID; user messages carry role/content, parent_tool_use_id, and session_id in the SDK-compatible envelope.

Dispatch CLI can_use_tool requests concurrently with reading output. Bridge them to existing approval/question promises and answer using control_response with nested subtype, request_id, and response. Allow replies include updatedInput (original input when unchanged); question replies include validated answers. Handle control_cancel_request by aborting the corresponding pending UI request and suppressing late answers. Unknown request subtypes receive explicit protocol errors rather than implicit approval. Normal unknown informational events can be ignored.

Interrupt uses a correlated interrupt control request, discards unsent turns, and settles pending requests exactly once. Preserve a usable process after per-turn errors; honor result.is_error even when subtype is success. A result ends a turn, not stdin or the process. Keep reading trailing events and future turns. Correlate cancellation/late events so an interrupted turn cannot complete a subsequent turn. Preserve existing send/queue semantics; do not introduce unrelated turn-scheduling changes.

### 5. Framing, bounds, and shutdown

Use streaming UTF-8 decoding and newline framing across arbitrary chunks, including multibyte characters, CRLF, multiple lines per read, and a final unterminated line. Ignore blank/non-JSON diagnostic lines with bounded diagnostics; malformed JSON-looking lines fail the session. Set a configurable frame ceiling (initially 16 MiB), bounded stderr tail, and write backpressure. Reject malformed known control envelopes; tolerate additive unknown fields.

Reject pending control calls on timeout, EOF, broken pipe, or process death; cancel UI requests and report a session-scoped error. On kill/shutdown, stop accepting messages, settle requests, close stdin, await a bounded graceful exit, then terminate and finally kill/reap the child if needed. Track all spawned probes/processes so failed initialization and backend shutdown do not orphan children. Never await approval answers inside the stdout read loop.

### 6. Preserve storage and profile compatibility

Retain sdkSessionId/sdk_session_id as historical field names; values are Claude Code conversation IDs and remain valid for --resume. Capture the system init session_id immediately and preserve it on failed resume. Transcript replay and exclusion from log discovery continue using that ID. Do not silently create a fresh conversation when an existing one fails to resume.

Keep shared ChatEvent, request IDs visible to browsers, registry updates, and WebSocket contracts unchanged. Adapt profile env/model/settings options to the CLI launch contract when profile work is applied; precedence must be proven with a mock endpoint and conflicting settings, not assumed from argument construction.

## Risks / Trade-offs

- [Internal control protocol changes] → Pin/document the tested CLI baseline, validate runtime handshake, and maintain fixtures plus a real subprocess contract test. Public print/stream flags are documented; internal controls need regression coverage.
- [Handshake does not prove tool approval parity] → Exercise allow/deny, AskUserQuestion, cancellation, interrupt, and resume against the installed CLI with a local mock provider before removing SDK reliance.
- [SDK removal removes bundled executable] → Document independent installation and server-only executable selection before rollout.
- [Late frames or shutdown races] → Correlated request state, idempotent settlement, asynchronous reading, and bounded cleanup tests.
- [Profile plan assumes SDK options] → Preserve equivalent launch inputs and reconcile dependent artifacts before implementation/archive.

## Migration Plan

Merge the implemented provider profiles first. Introduce and test the adapter alongside current code, switch the injected driver/manager factory, then remove all SDK imports and the package/lockfile dependency. Keep database and WebSocket schemas intact. Install the tested CLI separately on the backend before deploying updated application code. Infrastructure changes are outside this plan and require reading the Relaydeck guides before execution.

Rollback by restoring the prior application/package lockfile and SDK dependency; persisted IDs/transcripts remain usable. No data migration or deletion is required. Update SDK-specific wording in main specs through the update workflow before archive, preserving their user-facing acceptance criteria and leaving historical archives intact.
