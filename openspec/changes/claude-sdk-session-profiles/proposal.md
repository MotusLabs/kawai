# Proposal

## Why

Claude SDK chat sessions currently inherit one backend environment, while users already choose provider and model combinations through Claude CLI wrappers. A predefined profile selector will let each chat session use the intended provider and models without changing the backend environment for every session.

## What Changes

- Add a server-owned catalog of predefined Claude SDK profiles, grounded in the environment assignments in `/usr/local/bin/claude-provider`: Default, GLM, MiniMax, MiMo, Kimi, and LAN.
- Let users select a profile when creating a chat session and display the selected profile for that session.
- Resolve the selected profile into SDK environment and startup model options per session, preserving chat tool approvals.
- Persist the profile identifier so resumed sessions retain their provider selection; existing sessions use Default.
- Validate profile identifiers server-side and expose only profile identifiers and labels to clients.
- Document wrapper discrepancies, environment precedence, authentication, and profile maintenance. GLM Flash requires a separate decision because its installed wrapper has no matching branch.

## Capabilities

### New Capabilities

- `claude-session-profiles`: Predefined Claude provider/model selection for SDK chat sessions, isolated launch configuration, and durable profile identity.

### Modified Capabilities

None. The related `chat-sessions` capability exists only in the active `claude-sdk-chat-sessions` change, not in main specs. This change extends that work and must be applied after its session creation, persistence, and UI integration are available.

## Impact

Shared session and creation contracts, server chat manager/driver, SQLite chat-session records, server profile catalog and metadata endpoint, client new-session and chat UI, and associated tests/documentation. No new SDK dependency is required. Terminal command presets and installed wrapper files remain outside this change. The backend must be able to reach the configured gateways and have suitable credentials; this proposal does not change deployment infrastructure.
