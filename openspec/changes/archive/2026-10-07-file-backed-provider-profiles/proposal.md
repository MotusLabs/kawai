# Proposal

## Why

The chat profile catalog is compiled into the server (`src/server/chat/ClaudeProfiles.ts`), hand-mirrored from the `/usr/local/bin/claude-provider` wrapper. Adding or editing a profile requires a code change, CI, and a redeploy, and the mirror is already drifting: a `claude-glm-flash` symlink exists whose wrapper branch and catalog entry were never added. Profile definitions are configuration, not code — they should be files, like Claude Code settings.

## What Changes

- Profile catalog moves from hardcoded TypeScript to `.kawai/profiles.json` files, discovered server-side by walking from the session's project path up to the filesystem root, plus a user-level `~/.kawai/profiles.json`. Nearest file wins; entries with the same id merge per environment key; an empty value neutralizes an inherited value; the implicit `default` profile becomes definable in files.
- The six current profiles ship as a user-level catalog file. Container deployments mount it (ConfigMap) or bake it into the image as the fallback; a mounted catalog replaces the baked one when present.
- A user-level catalog entry may name an `executable` — an operator-trusted wrapper launched instead of the standard Claude Code binary, with the merged base environment (including credentials) passed through and no server-injected inline settings, so the wrapper's own configuration wins. Project-level catalog files cannot name executables, and the client API remains identifier-only; clients can never supply paths or environment maps.
- Credentials stay out of catalog files: the Settings provider-env panel and `AGENTBOARD_CHAT_ENV` keep their current roles as the environment merge base and credential store for every session.
- Terminal commands are out of scope: kawai writes no executables and manages no shims; existing wrapper scripts remain user-maintained.
- The chat profile picker fetches the catalog for the selected project path. Resume re-resolves the stored profile id against the filesystem at spawn and keeps the existing actionable-error behavior when the defining file is gone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: the catalog source becomes layered `.kawai` files with per-key merge instead of a fixed built-in list; the prohibition on wrapper commands is refined to the client API (operator-owned catalog files may name trusted executables, whose flags the operator owns); `default` becomes definable in files; the availability probe keys on the resolved launch configuration including any executable.

## Impact

- Server: `ClaudeProfiles.ts` (file discovery, layered merge, executable resolution), `routes/claudeProfiles.ts` (catalog endpoint takes a project path), `sdkAvailability.ts` (probe identity includes the executable), `ChatSessionManager.ts`/`ChatSessionDriver.ts` (spawn via profile executable).
- Client: `useClaudeProfiles.ts` and `NewSessionModal.tsx` re-fetch the catalog when the selected project path changes.
- Spec: delta for `claude-session-profiles`; scenarios that assumed the fixed six-profile list move to file-based examples.
- Deployment: image carries a default catalog; a mounted ConfigMap overrides it. Adding profiles afterward needs no rebuild.
- Sequencing: lands before `replace-claude-sdk-with-cli` so the CLI driver consumes the file-backed catalog directly.
