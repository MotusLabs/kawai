## Why

The change apply auto-start never works: the command is sent as tmux keystrokes the
moment the session is created, before the agent's TUI is reading stdin, so the text
lands in the composer unsubmitted (or is swallowed entirely). The trigger is a false
idle — a brand-new tmux window has no pane cache, and `inferSessionStatus` reports
`waiting` on its first sample by definition, which `PendingAutoStartStore.injectWaiting`
reads as "the agent is ready."

Waiting longer cannot fix this. A session started in a fresh worktree opens on Claude's
trust dialog, whose default option is **No, exit** — an auto-injected Enter there kills
the session — and Codex's unauthenticated onboarding screen has the same shape. Both
CLIs accept an interactive first prompt as an argv positional, which the agent itself
holds until after trust and login are resolved, removing the race and the readiness
guesswork together.

## What Changes

- Compose the apply command into the session's start command (`claude '/opsx:apply <change>'`)
  instead of injecting it as keystrokes after creation.
- **BREAKING** (internal): remove `src/server/pendingAutoStart.ts`, `sendAutoStartInput`,
  `reconcilePendingAutoStart`, and the auto-start `setForceWorking` override. The
  server no longer holds pending prompts or watches for a first idle status.
- Replace the session form's auto-start checkbox with a "Start with" dropdown offering
  Claude, Codex, and Nothing, labelled with the literal prompt each would send.
- Default the dropdown from the selected preset's declared `agentType`, else from a
  `claude*` / `codex*` prefix match on the command's resolved agent token, else Nothing.
  The default recomputes as the command changes until the user picks a value explicitly.
- Show the dropdown for every command and every host, including remote hosts, whenever
  the form is opened from a change section. The previous local-only restriction existed
  only because injection needed a local terminal-input path.
- Extract the agent-token walk in `inferAgentType` as a shared `resolveAgentToken` so the
  prefix rule skips runners, env assignments, and flags the same way exact matching does.
  `inferAgentType` itself stays exact-match.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-navigation`: `Requirement: Auto-start the change's apply command` mandates
  injection at the first idle status with a server-held pending command; it becomes an
  argv-composed first prompt selected in the session form, available on remote hosts,
  with no pending state and no idle-status trigger. The worktree session-form scenario
  that offers "the auto-start option" changes to offer the dropdown.

## Impact

- `src/server/pendingAutoStart.ts` — deleted, with `src/server/__tests__/pendingAutoStart.test.ts`.
- `src/server/index.ts` — remove the injection path and pending-store wiring; compose the
  start command in the `session-create` handler for both local and remote creation.
- `src/server/agentDetection.ts` — extract `resolveAgentToken`; keep `inferAgentType` exact.
- `src/client/components/NewSessionModal.tsx` — checkbox replaced by the dropdown.
- `src/client/App.tsx`, `src/shared/types.ts` — `session-create` carries the selected
  agent alongside the change name.
- No change to `statusInference.ts`. Its first-sample `waiting` result is no longer
  load-bearing for this feature, though it remains inaccurate for new windows.
