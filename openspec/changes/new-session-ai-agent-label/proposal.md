# Proposal

## Why

The New Session dialog labels its agent-backed session kind “Chat,” although the same form supports Claude and Codex runtimes and multiple providers. `AI agent` accurately describes the available choice before a user selects a profile.

## What Changes

- Display the exact text `AI agent` for the agent-backed option in the New Session dialog's Session kind selector.
- Align the directly related profile-selection instructions and stale test descriptions with that wording.
- Preserve the existing `chat` option value, creation payload, profile picker, and default-kind behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: the shared profile-selection entry point uses a provider-neutral session-kind label.

## Impact

`src/client/components/NewSessionModal.tsx`, directly related descriptions in `src/client/__tests__/newSessionModal.test.tsx`, and the opening instructions in `docs/claude-session-profiles.md`. No backend, stored identifiers, protocols, or runtime selection changes.

The committed base labels this option `Chat` (`src/client/components/NewSessionModal.tsx:549`, `<option value="chat">Chat</option>`). Implementation changes that one line to `AI agent` on an isolated future implementation branch; unrelated edits on main and in any working tree are out of scope and preserved. No implementation edits are part of this proposal.
