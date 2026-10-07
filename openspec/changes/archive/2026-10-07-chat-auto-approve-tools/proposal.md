# Proposal

## Why

Every chat tool use that Claude Code settings do not already allow stops on an approval card, so a long, trusted task cannot run unattended in a chat session the way a terminal session launched with skip-permissions can. Users need an explicit per-session switch to let the agent proceed, designed so that a later small-model approver can slot in as a third policy.

## What Changes

- Add a per-session **approval policy** for chat sessions: `manual` (today's behavior) or `auto`. The stored value is an enum so a future `ai` policy needs no migration; the server accepts only `manual` and `auto` for now.
- Under `auto`, tool approvals are granted without showing a card. `AskUserQuestion` is never auto-answered: questions always go to the question form. Deny rules in Claude Code settings keep applying, because the CLI evaluates them before Kawai is asked.
- Every chat session starts as `manual`. There is no global or per-profile default.
- Switching to `auto` grants the session's approval cards that are already pending; pending questions stay open. Switching to `manual` affects only later requests.
- The policy is persisted with the session and survives server restart, resume, archive, and restore. It cannot be changed while the session is archived.
- The chat view header gets an approval-policy control next to Debug and Archive, with a clear "Auto-approve" indicator while `auto` is on. The control is hidden for archived read-only chats.
- Resolution events record who decided (`user` or `policy`), so the transcript marks auto-approved tool uses and a later model approver can report itself without another contract change. A transcript notice records each policy change.
- The change takes effect live over the existing chat WebSocket; the agent process is not restarted.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: approval cards apply under the manual policy; a new requirement defines the per-session approval policy, its default, live switching, persistence, visibility, and the AskUserQuestion exception.
- `claude-session-profiles`: "Profiles preserve chat permissions and credential privacy" now allows a user-chosen per-session auto-approve policy, while a profile wrapper's skip-permissions flag is still not imported.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts` (`canUseTool` consults the policy), a new small policy module, `ChatSessionManager.ts` (set/persist/apply policy), `ChatConnections.ts` (new `chat-set-approval-policy` message), `src/server/db.ts` (additive `approval_policy` column with a `manual` default).
- Shared contracts: `src/shared/chat.ts` (`ChatApprovalPolicy`, optional `decidedBy` and `tool` on `request_resolved`), `src/shared/types.ts` (session `approvalPolicy`, new client message). All additions are optional or additive; older clients keep working.
- Client: `ChatView.tsx` header control and indicator, `ChatMessages.tsx` auto-approved rendering, `chatStore.ts` handling of resolutions with no prior card.
- Not affected: terminal sessions, provider profiles' launch configuration, the SDK `permissionMode` (stays `default`). The in-flight `replace-claude-sdk-with-cli` change keeps the same `canUseTool` hook, so this change does not depend on its transport.
