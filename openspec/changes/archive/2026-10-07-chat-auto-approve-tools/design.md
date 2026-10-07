# Design

## Context

Chat sessions run Claude Code through the Agent SDK with `permissionMode: 'default'`. The CLI applies the user's settings allow and deny rules itself; it calls the SDK `canUseTool` callback only for tool uses that are still undecided. In `ChatSessionDriver`, `canUseTool` turns each call into a pending request, emits `approval_request` (or `question_request` for `AskUserQuestion`), and waits for `resolveApproval`/`answerQuestion`. Session status is `permission` while any request is pending.

Session metadata lives in `chat_sessions` (`claude_profile_id` and `archived_at` were added the same way: a nullable/defaulted column plus a startup `ALTER TABLE`). `ChatSessionManager.applyPatch` persists a record change and broadcasts the updated `Session` to all clients. `ChatConnections.handle` routes `chat-*` client messages to the manager.

`ChatSessionDriver.ts` and `ChatSessionManager.ts` are already about 640 lines each, above the project's 500-line guideline. This change must not grow them much.

## Goals / Non-Goals

**Goals:**
- One decision point for "who answers this approval", which a later model-based approver can join without new contracts or migrations.
- Live switching with no agent restart, shared by all clients attached to the session.

**Non-Goals:**
- The `ai` policy itself, per-tool remembered rules, or Claude Code permission modes such as `acceptEdits`, `auto`, or `plan`.
- Restoring auto-approval marks after a server restart. Today the restored history is rebuilt from the SDK transcript and user Allow/Deny marks are not restored either; this change keeps that behavior.
- Splitting the oversized driver and manager files beyond what this change touches.

## Decisions

### D1: Decide in Kawai's `canUseTool`, not through the SDK permission mode

`canUseTool` asks a small pure function, `decideApproval(policy, toolName)`, in a new `src/server/chat/approvalPolicy.ts`. It returns `ask` or `allow`. `AskUserQuestion` always returns `ask`. For `allow`, the driver resolves immediately with `{ behavior: 'allow' }` and emits one `request_resolved` event (D3). No pending request is created, so status never becomes `permission`.

Alternatives considered:
- `permissionMode: 'bypassPermissions'` switched live with `query.setPermissionMode()`. It needs `allowDangerouslySkipPermissions` at spawn time, it is not clear whether `AskUserQuestion` still reaches `canUseTool` in that mode, and the `replace-claude-sdk-with-cli` change would have to rebuild it in a new transport. The `canUseTool` hook exists in both transports.
- Keep the SDK mode and add a settings allow-all rule. It would mutate the user's Claude Code settings, which other sessions also read.

Because the CLI evaluates settings deny rules before calling `canUseTool`, those rules keep applying with no extra work.

### D2: The driver reads the policy through a getter

The driver receives `getApprovalPolicy: () => ChatApprovalPolicy` from the manager, which reads it from the session record at each `canUseTool` call. A policy change therefore affects the next request without restarting or reconfiguring the driver, and a session restored from the database without a live driver needs no extra wiring. Passing the value once at construction would need a setter and a second source of truth.

### D3: Resolutions record who decided

`request_resolved` gains two optional fields: `decidedBy: 'user' | 'policy'` and `tool?: string`. User Allow/Deny sets `decidedBy: 'user'`. Policy grants set `decidedBy: 'policy'`. A grant made without a card carries `tool` and a fresh request id, because no `approval_request` came before it to name the tool. Cancellations leave both fields unset. A later approver adds `'model'` to the union. `ChatMessages` renders `decidedBy: 'policy'` as "Auto-approved <tool>" and keeps the current text for everything else, so events without the fields render as today.

Alternative considered: emitting `approval_request` followed at once by `request_resolved`. It reuses the existing rendering but briefly flashes a card and a `permission` status on every client.

### D4: Switching policy

New client message: `{ type: 'chat-set-approval-policy', sessionId, policy }`. `ChatConnections` validates the value against `manual | auto`. `ChatSessionManager.setApprovalPolicy` refuses an archived session and treats setting the current value as a no-op. Otherwise it persists through `applyPatch` (which broadcasts the `Session`) and tells the live driver, if any, via `driver.onApprovalPolicyChanged(policy)`. Switching to `auto` makes the driver grant its pending approvals: each settles with `allow` and emits `request_resolved` with `decidedBy: 'policy'`. Pending questions are left alone. For every change, the manager also appends a `notice` ("Auto-approve on" / "Auto-approve off") to the session's live events through the same path as driver events (`handleDriverEvent` assigns its sequence). That is how the change reaches attached transcripts and the attach snapshot, whether or not a driver is running.

### D5: Storage and session metadata

Add `approval_policy TEXT NOT NULL DEFAULT 'manual'` to `chat_sessions` through the existing startup migration, so legacy rows read as manual. Expose it on the shared `Session` as optional `approvalPolicy?: ChatApprovalPolicy` (`'manual' | 'auto'`), next to `claudeProfileId`. Session creation always writes `manual`; `session-create` gets no policy field. An unknown stored value reads as manual.

### D6: Header control

`ChatView` adds a toggle button next to Debug and Archive, with `aria-pressed` set while `auto` is on. While on, the button uses a warning style and the label "Auto-approve", so the header stands out from manual sessions. The button is not rendered for archived sessions. It sends `chat-set-approval-policy` and renders from the broadcast `Session`, not from local optimistic state, so all clients agree.

## Risks / Trade-offs

- [Unattended destructive tool use] → Off by default per session, explicit per-session opt-in, a visible header state, a transcript notice and per-call marks. Settings deny rules still apply.
- [A future SDK/CLI change routes `AskUserQuestion` differently] → The tool-name check lives in `approvalPolicy.ts` with unit tests, and the existing driver tests for questions run under both policies.
- [Anyone who can open the UI can turn on auto] → They can already click Allow on every card; the policy removes the pause, not an access boundary. Kawai's access control is unchanged.
- [Marks are lost after server restart] → Accepted (see Non-Goals); the header still shows the restored policy.

## Migration Plan

The additive column defaults to `manual`, so existing sessions keep today's behavior. Older clients ignore the new optional fields and never send the new message. Rollback: older servers ignore the extra column.
