# Design

## Context

`SettingsModal.tsx` is 992 lines and renders ten sections in one scroll inside a `max-w-lg` form. It mixes three persistence models: localStorage drafts committed by the form's Save, four server settings that PUT immediately on toggle, and `ChatProviderSettings` with its own Apply. See `proposal.md` for motivation.

Chat session creation is a `session-create` WebSocket message; `ChatSessionManager.createSession` hardcodes `approvalPolicy: 'manual'`. The per-session header toggle (`chat-set-approval-policy`) is the only way to change it afterward. The settings store already carries "what new sessions look like" preferences (`defaultProjectDir`, `defaultPresetId`) in browser localStorage.

## Goals / Non-Goals

**Goals:**
- Four-tab Settings layout with one component per section, each file under 500 lines.
- A creation-time approval policy that is seeded from a Settings default and overridable per session.
- Backward compatibility: clients that send no policy create manual sessions exactly as today.

**Non-Goals:**
- Changing how any setting commits. The mixed draft / immediate-PUT / own-Apply behavior stays; see Risks.
- A server-side or per-profile default. Profiles must still not influence the policy (spec delta in `claude-session-profiles`).
- Applying a policy to existing sessions, or adding bulk operations.
- Persisting which tab was last open.

## Decisions

### D1. The default lives in the client settings store, not on the server

`defaultApprovalPolicy: ChatApprovalPolicy` sits beside `defaultPresetId` in `useSettingsStore`, defaulting to `'manual'` and sanitized on merge the way pane fractions are (anything other than `'auto'` reads as `'manual'`, matching server-side `parseApprovalPolicy`).

*Why:* it is the same class of preference as the other "what new sessions look like" settings, it is per-browser, and it needs no new endpoint. The server cannot read localStorage anyway — the value has to travel with the create call.

*Alternative:* a server setting like `history-max-age-hours`, fetched and PUT from Settings. Better if an operator wants to pin the policy for a shared deployment. Rejected because this is a personal working preference and the per-session header toggle remains the source of truth for a session's whole life.

### D2. New Session carries the explicit choice; Settings only seeds it

The New Session dialog shows an "Auto-approve tools" checkbox for `kind === 'chat'`, pre-checked from the stored default. The settings store is a convenience seed; the checkbox is the deliberate act.

*Why:* the spec being amended reserved auto-approve for the user's explicit choice. Seeding keeps that spirit — Settings saves the repetition, the dialog is where the user confirms it for this session. A trust-level default that silently decides every future session is too quiet.

### D3. Wire: optional `approvalPolicy` on `session-create`, absent means manual

`session-create` gains `approvalPolicy?: ChatApprovalPolicy`. `handleCreateSession` threads it through; `index.ts` passes it to `createSession`, which uses it instead of hardcoding `'manual'` and falls back to `'manual'` when absent.

*Why:* purely additive. Old clients, `handleDuplicateSession`, and the development fixture all keep producing manual sessions. Nothing migrates.

### D4. Four tabs: Sessions / Chat / Terminal / General

Dark Mode moves to General (it themes the whole app, not xterm). All chat settings — the new default, chat font size, provider env — sit together on Chat. Notifications and the shortcut modifier join theme on General.

*Why:* four tabs, not five — an Appearance tab holding one switch is not worth a nav row. Command Presets stays on Sessions beside the default-preset selector rather than getting its own tab: the selector and the editor that feeds it should not be split across a tab boundary.

### D5. Sections extract to `src/client/components/settings/`, drafts stay in the shell

One component per section. The shell keeps tab state, the localStorage drafts, `handleSubmit`, Escape handling, and the open/close effects. Server-backed settings (mouse mode, terminal colors, history lookback, window names) move into their sections with their immediate-PUT handlers, since they self-save and never touch the form draft. Ephemeral UI state (the add-preset form) moves with its section.

*Why:* lifting every section's draft into an imperative handle would add machinery to preserve one submit path that already works. Keeping drafts in the shell means `form.props.onSubmit` tests and the Save/Cancel contract are unchanged. Moving the self-saving settings out actually shrinks the shell.

*Alternative:* each section owns its draft and the shell collects on submit. Cleaner ownership, but needs refs or context purely to keep Save working.

### D6. Inactive tab panels stay mounted with the `hidden` attribute

*Why:* existing tests find controls by text across the whole modal; unmounting panels would force every one of them to click through tabs first. `hidden` removes the panel from the accessibility tree and tab order, so the a11y cost is avoided. A settings modal is small enough that mounting all panels is free.

*Alternative:* unmount inactive panels. Cleaner DOM, significant test churn for no user-visible gain.

### D7. The approval control is a segmented `[ Manual | Auto-approve ]`

Matches the spec's two named policy states and the header toggle's vocabulary, rather than a Switch whose label has to carry "default for new chats".

## Risks / Trade-offs

- **The four immediate-PUT settings still survive Cancel.** → Out of scope by decision. Grouping them under their sections at least keeps them visually together; a follow-up can fold them into the draft. The new approval default joins the draft row, so it behaves like `defaultPresetId`.
- **A stored default of `auto` makes every new chat auto-approve.** → The New Session checkbox is visible and pre-checked from that default, and the Settings copy names the consequence ("Auto-approve lets tools run without asking"). Users who never open New Session's chat path still see the header toggle once the session exists.
- **Tabs hide controls from a user who does not notice the nav.** → Each tab is one concern, and the modal opens on Sessions — the tab most users touch most. If discoverability becomes a complaint, a sticky section index can be added without another IA pass.
- **Splitting `SettingsModal.tsx` risks breaking its 437-line test file.** → The shell keeps the submit contract and draft ownership (D5); only the server-backed handlers move. Run `settingsModal.test.tsx` after each section extract rather than after the whole split.

## Migration Plan

None. `defaultApprovalPolicy` is additive: the persist `merge` spread supplies `'manual'` for stores written before this change, so the settings store needs no version bump. The wire field is optional and defaults to manual server-side. Rollback is a revert — no stored data changes shape.

## Open Questions

None material. Whether the tab strip should persist its last selection is decided as "no" (D4) and can be revisited without touching specs.
