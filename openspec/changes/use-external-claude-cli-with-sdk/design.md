# Design

## Context

See proposal.md for motivation and `../replace-claude-sdk-with-cli/decision.md` for measurements.

- `ChatSessionDriver.spawnQuery()` builds SDK `Options` (cwd, `claude_code` preset, setting sources, default permissions, partial messages, `canUseTool`, resume, profile launch config, and `spawnClaudeCodeProcess` from `wireTap.ts`). No executable path is set, so the SDK resolves `@anthropic-ai/claude-agent-sdk-<platform>` relative to its own module.
- `ChatSessionManager.probeAvailability()` caches `probeSdkAvailability()` (initialize-only handshake, 20 s abort) per `claudeLaunchKey(launch)`; failures are evicted. Creation maps any probe error to "Claude Agent SDK is unavailable…". Respawn of a dead driver re-checks profile and auth only.
- Tests inject `queryFactory`/`availabilityProbe`; with an injected factory the default probe is a no-op. The development fixture also bypasses the real SDK.
- Release binaries are `bun build --compile` outputs run without `node_modules`. A compiled probe fails the bundled lookup and succeeds with `pathToClaudeCodeExecutable`.
- Bun 1.4.2 install filters by OS/CPU only; `--omit=optional` also drops lightningcss/oxlint/rolldown bindings.

## Goals / Non-Goals

**Goals:** one resolved executable used by every chat spawn and probe; an explicit, tested minimum version; specific errors per failure mode; a dependency tree without the SDK platform CLIs.

**Non-Goals:** replacing SDK protocol handling; installing or downloading Claude Code; per-profile or per-session executables; a Settings UI for the path; changing wire capture, profiles, storage, or client contracts.

## Decisions

### 1. Exclude the platform CLIs with `overrides` to a local empty package

Add `packages/claude-agent-sdk-no-cli/package.json` (name and version only) and map all eight `@anthropic-ai/claude-agent-sdk-<platform>` names to `file:./packages/claude-agent-sdk-no-cli` in `package.json` `overrides`, then regenerate `bun.lock`. Measured: `node_modules` 1019 → 596 MB with other native bindings intact, and the frozen lockfile stays deterministic.

Alternatives: `--omit=optional` (breaks build/lint tooling); deleting the directories after install (every install still downloads ~464 MB, and the lockfile still lists them); a third-party empty package (an unnecessary external dependency). The override list must track the SDK's `optionalDependencies`; a unit test asserts that every optional dependency name in the installed SDK `package.json` is overridden.

### 2. A small executable module owns resolution and version checks

New `src/server/chat/claudeExecutable.ts`:

- `resolveClaudeExecutable(env = process.env)`: trimmed `KAWAI_CLAUDE_PATH` if non-empty, else `Bun.which('claude', { PATH: env.PATH })`. The value is used as a path only and is never split or passed to a shell. It must be a regular file (following symlinks) with execute permission. Returns the path as configured (not its realpath), so a symlink such as `~/.local/bin/claude` keeps following upgrades.
- `checkClaudeExecutable(path)`: `Bun.spawn([path, '--version'])` with stdin ignored, a 10 s deadline, then kill and await exit on timeout. Parse the leading `MAJOR.MINOR.PATCH`; compare with `CLAUDE_CODE_MIN_VERSION = '2.1.289'`. Newer versions pass this gate and must still pass the existing handshake probe.
- Failures throw `ClaudeExecutableError` with kind (`missing`, `not-executable`, `unsupported`, `probe-failed`) and a message naming the checked path, the found/minimum version where relevant, and the fix (install Claude Code, upgrade, or set `KAWAI_CLAUDE_PATH`).
- Results are cached per `path + realpath + mtime` so an upgrade in place re-checks, and failures are not cached. A unit test pins `CLAUDE_CODE_MIN_VERSION` to the SDK `package.json` `claudeCodeVersion`, so an SDK bump forces a deliberate baseline update.

The executable is resolved from the server environment rather than per-profile provider env: it is installation, not provider, configuration.

### 3. Thread the path through probe and spawn

- `ChatSessionManager` gains an injectable `executableCheck: () => Promise<string>` (default: resolve + check). `probeAvailability()` awaits it first, then calls the handshake probe with the path; the probe cache key includes the path. Creation reports `ClaudeExecutableError` messages verbatim and keeps the existing SDK-handshake message for other failures.
- `ensureDriver()` runs the (cached) executable check before creating a driver and before reusing a dead one, so a removed executable surfaces the same error on send without touching the record or `sdkSessionId`.
- `probeSdkAvailability(providerEnv, launch, executablePath)` and `ChatSessionDriverOptions.claudeExecutablePath` add `pathToClaudeCodeExecutable` to SDK options. When omitted (injected factories, fixture), behavior is unchanged.
- `wireTap.ts` is unchanged: for a native executable the SDK passes it as `command`, which the tap spawns and records exactly as before.

### 4. Defaults when a fake runtime is injected

As today, an injected `queryFactory` implies a no-op default executable check, so the unit suites and `AGENTBOARD_CHAT_FIXTURE=1` e2e runs need no Claude Code install. CI therefore needs no change.

## Risks / Trade-offs

- [The installed CLI is newer than the SDK expects and the internal protocol changes] → the handshake probe still gates creation; the baseline test forces review on SDK upgrades; docs say to upgrade the SDK and CLI together when a handshake starts failing.
- [Developers without `claude` on PATH lose real chat locally] → fixture mode is unaffected; the error names the fix; docs cover the install.
- [The overrides list misses a new platform package in a future SDK] → the override coverage test fails on SDK upgrade.
- [`--version` output format changes] → parse only the leading semver and report the raw output in the `probe-failed` error.

## Migration Plan

1. Install Claude Code ≥ 2.1.289 on every host that runs chat (dev, backend). For releases, it must be on the service's `PATH` or set in `KAWAI_CLAUDE_PATH`.
2. Deploy. Existing sessions resume unchanged because conversation IDs and transcripts do not depend on the CLI's install location.
3. Rollback: revert the commit. This restores the SDK platform packages and the bundled-binary lookup. No data migration is needed.
4. After verification, withdraw `replace-claude-sdk-with-cli` instead of archiving it as implemented.
