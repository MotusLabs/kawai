# Proposal

## Why

The Settings modal has accreted into a 992-line, ten-section scroll that mixes unrelated concerns and three different save models. Theme is buried under Terminal Rendering, chat settings are split across two bands, and Cancel silently fails to undo the four settings that PUT on toggle. It is overdue for an information-architecture pass.

Separately, every new chat session is hardcoded to the manual approval policy. A user who works auto-approve has to flip the header toggle on every single session, even though the choice is a standing preference rather than a per-conversation one.

## What Changes

**Settings reorganization** (UI only — no spec-level behavior change)

- Restructure the modal into four tabs — Sessions, Chat, Terminal, General — instead of one continuous scroll.
- Split `SettingsModal.tsx` (992 lines, over the project's <500 guideline) into a shell plus one component per section.
- Redistribute existing controls: all chat settings under Chat; Dark Mode moves out of Terminal Rendering into General; notifications and the shortcut modifier join theme under General.
- Save semantics are deliberately left alone. The modal keeps its mixed draft / immediate-PUT / own-Apply behavior; the new approval-policy setting joins the draft row and commits on Save.

**Default approval policy for new chat sessions**

- Add a client-side setting, `defaultApprovalPolicy`, stored beside `defaultPresetId` in the settings store.
- Seed a new "Default Approval Policy" control on the Chat tab from it.
- Let the New Session dialog override it per creation via an "Auto-approve tools" checkbox shown only for chat sessions.
- Extend the `session-create` wire message with an optional `approvalPolicy`; the server applies it at creation and falls back to `manual` when absent.
- **BREAKING** (spec rule, not stored data): the existing rule that "there SHALL be no global or per-profile default" is reversed for this client default. Profiles still must not set a session's policy. Existing sessions and existing clients are unaffected — an unspecified policy still creates a manual session.

## Capabilities

### New Capabilities

None. The tab reorganization is presentation structure with no new system behavior, and the default policy is a new requirement inside chat-session behavior rather than a cohesive capability of its own. The Settings modal has no dedicated capability today and starting one for a single control would not improve the spec inventory.

### Modified Capabilities

- `chat-sessions`: "Chat sessions have a per-session approval policy" stops forbidding a default and gains the create-time value rules; a new requirement covers configuring the default from Settings and overriding it at creation.
- `claude-session-profiles`: "Profiles preserve chat permissions and credential privacy" rewords "only the user's explicit per-session policy choice" so a creation-time value is allowed while profiles still cannot change a session's policy.

## Impact

- `src/client/components/SettingsModal.tsx` — becomes a tab shell + form/save; sections extracted.
- `src/client/components/settings/` (new) — one component per tab section.
- `src/client/stores/settingsStore.ts` — `defaultApprovalPolicy` + setter.
- `src/client/components/NewSessionModal.tsx` — chat-only "Auto-approve tools" checkbox seeded from the default.
- `src/client/App.tsx` — thread the new create argument through `handleCreateSession`.
- `src/shared/types.ts` — `session-create` gains optional `approvalPolicy`.
- `src/server/index.ts` — pass `approvalPolicy` into chat session creation.
- `src/server/chat/ChatSessionManager.ts` — `createSession` accepts an optional policy instead of hardcoding `manual`.
- Specs: deltas under `chat-sessions` and `claude-session-profiles`.
- Tests: `settingsModal.test.tsx`, `settingsStore.test.ts`, `newSessionModal.test.tsx`, `chatSessionManager.test.ts`, `chatConnections.test.ts`, `chatApprovalPolicyDb.test.ts`.
