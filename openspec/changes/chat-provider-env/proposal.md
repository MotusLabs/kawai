# Proposal

## Why

Chat sessions spawn the Claude Agent SDK without an `env` option, so the SDK
subprocess inherits whatever environment the Agentboard server was launched
with. Operators who route Claude Code through an Anthropic-compatible gateway
(a self-hosted proxy, a regional endpoint, an alternative model provider) do
that per shell — `ANTHROPIC_BASE_URL` plus model overrides — and have no way to
point chat sessions at the same provider. Setting those variables on the server
process is not a workable substitute: service installs (systemd, launchd) start
with a minimal environment, and anything in the server environment also leaks
into every tmux terminal session through the inherited tmux env.

## What Changes

- Chat sessions gain a **provider environment**: a set of `KEY=VALUE`
  overrides applied only to the SDK subprocesses Agentboard spawns for chat
  (the per-session query and the one-time availability probe). Terminal
  sessions are unaffected.
- The provider environment is seeded from a new server variable,
  `AGENTBOARD_CHAT_ENV="KEY=VALUE;KEY=VALUE"`, and can be overridden from the
  Settings modal (persisted in `app_settings`). Clearing the Settings value
  falls back to the server variable.
- The chat auth gate evaluates credentials against the effective environment
  (server env plus provider overrides), so a gateway token supplied as a
  provider override is accepted, and the gate never disagrees with what the
  spawned subprocess sees. `ANTHROPIC_AUTH_TOKEN` joins the accepted
  credential variables.
- With nothing configured, behavior is unchanged: the SDK `env` option is
  omitted and the subprocess inherits the server environment.
- Non-goal: per-session provider choice in the new-session form; provider
  selection for terminal sessions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: chat sessions run against an operator-configured provider
  environment, configurable from the server environment and from Settings.
