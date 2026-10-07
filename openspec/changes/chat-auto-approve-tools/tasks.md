# Tasks

## 1. Contracts and storage

- [x] 1.1 Add `ChatApprovalPolicy = 'manual' | 'auto'` and optional `decidedBy: 'user' | 'policy'` and `tool` on `request_resolved` in `src/shared/chat.ts`; add optional `approvalPolicy` to `Session` and the `chat-set-approval-policy` client message in `src/shared/types.ts`; verify `bun run typecheck` passes
- [x] 1.2 Add the `approval_policy TEXT NOT NULL DEFAULT 'manual'` column with the startup migration in `src/server/db.ts`, map it through `getChatSession`/`insertChatSession`/`updateChatSession` (an unknown stored value reads as manual), and extend the legacy-schema DB tests (pattern of `chatArchiveDb.test.ts`) so a pre-feature row reads as `manual` and an update round-trips `auto`

## 2. Policy decision and driver

- [x] 2.1 Create `src/server/chat/approvalPolicy.ts` with `decideApproval(policy, toolName)` (design D1) and a header comment; verify unit tests cover manual → ask, auto → allow, and `AskUserQuestion` → ask under both policies
- [x] 2.2 In `ChatSessionDriver`, take a `getApprovalPolicy` option, grant `allow` decisions in `canUseTool` immediately with a policy `request_resolved` carrying `tool` and no pending request, and set `decidedBy: 'user'` on user Allow/Deny; verify driver tests show no `approval_request`, no `permission` status under auto, questions still pending under auto, and unchanged manual behavior
- [x] 2.3 Add `onApprovalPolicyChanged(policy)` to the driver, which on `auto` grants pending approvals with `decidedBy: 'policy'` and leaves questions pending; verify a driver test with one pending approval and one pending question

## 3. Manager and WebSocket routing

- [ ] 3.1 Add `ChatSessionManager.setApprovalPolicy` (design D4): write `manual` on creation, refuse archived or unknown sessions, persist via `applyPatch` so the `Session` broadcast carries `approvalPolicy`, call the live driver, append the on/off `notice` through the live-event path, and pass `getApprovalPolicy` to drivers; verify manager tests for broadcast, the notice in a later `getSnapshot`, archived refusal, a no-op repeat, a change with no live driver, and policy kept across restart (restore from DB) and archive/restore
- [ ] 3.2 Route `chat-set-approval-policy` in `ChatConnections`, rejecting values other than `manual`/`auto` with an error to the sender; verify `chatConnections.test.ts` covers a valid switch, an invalid value, and an archived session

## 4. Chat view

- [ ] 4.1 Add the approval-policy toggle to the `ChatView` header next to Debug/Archive (design D6), hidden for archived sessions and rendered from the broadcast `Session`; verify component tests for the off and on states, the sent message, and its absence in archived view
- [ ] 4.2 Render `request_resolved` with `decidedBy: 'policy'` as "Auto-approved <tool>" in `ChatMessages`, leaving other resolutions unchanged; verify component tests, plus a `chatStore` test showing a policy resolution with no prior card leaves pending requests and status intact
- [ ] 4.3 Update the chat-session notes in `CLAUDE.md` with the per-session approval policy and the `approval_policy` column; verify the text matches the implemented behavior

## 5. Integration checks

- [ ] 5.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 5.2 With the `dev-browser` skill against `bun run dev`, toggle Auto-approve with an approval card pending, confirm the card resolves, a tool runs with no card, the header indicator and transcript marks appear, a second tab sees the change, and the archived view hides the control; save screenshots as evidence
