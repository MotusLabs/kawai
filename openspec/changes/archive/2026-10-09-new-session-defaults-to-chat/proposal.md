# Proposal

## Why

The New Session dialog preselects Terminal on every open, so starting a Claude Code chat — the primary way this app is used — always requires an extra kind switch. Defaulting the dialog to chat removes that friction for the common case while leaving terminal one click away.

## What Changes

- The New Session dialog's "Session kind" selector preselects **Claude Code chat** instead of Terminal when the dialog opens.
- Entry points that open the dialog for a specific terminal purpose keep the Terminal default: opening it from an OpenSpec change section (which exists to offer the terminal-only "Start with" first-prompt selector) still preselects Terminal.
- Every open recalculates the preselected kind from that open's entry point: ⌘N or a worktree action preselects chat, a change section preselects Terminal, regardless of how any previous open ended.
- Nothing else changes: switching kind to Terminal still shows command presets, host picker, and Start with; chat still shows the profile selector; creation, validation, and all server behavior are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: add a requirement that the new-session dialog preselects the chat kind on open (except change-section entry points, which preselect terminal), and that switching kinds retains the entered project path and name.

## Impact

- `src/client/components/NewSessionModal.tsx` — initial `kind` state and the closed→open reset (lines ~105, ~137, ~174): derive the default from `initialAutoStartChange`.
- `src/client/__tests__/newSessionModal.test.tsx` — default-kind, reset, and change-section-default tests.
- No server, API, or persistence changes; the dialog remains stateless across opens apart from the kind default.
