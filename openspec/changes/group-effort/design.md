# Design

## Context

- Group files are parsed by `groupFile.ts` into a `GroupDefinition`. Unknown keys are ignored, and profile-routing set the precedent that a bad routing value is a warning (`group.warnings`, prefixed with the file and surfaced by `groupCatalog.ts` → `GET` team groups route) rather than a rejected file.
- The role prompt already follows the "read at every agent start" rule: `ChatSessionManager` passes the driver a `getSystemPromptAppend` getter that calls `SessionTeams.promptFor(sessionId, groupId)`, which reads the session's catalog (stamp-cached) and builds the prompt. The driver calls it while building SDK `Options` for each spawn, including in-place respawns and resumes.
- The Agent SDK exposes `Options.effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` and forwards it as the CLI's `--effort` flag. The CLI (2.1.296) also honors `CLAUDE_CODE_EFFORT_LEVEL` (which overrides for the session), a settings `effortLevel` default, a settings maximum that clamps any requested level, and `/effort` inside a running session.
- The profile catalog's env allowlist (`PROFILE_CONTROLLED_ENV`) excludes effort variables; an unlisted key rejects the whole catalog file.

## Goals / Non-Goals

**Goals:**
- One frontmatter key, resolved per agent start exactly like the role prompt, passed through the SDK's typed option.

**Non-Goals:**
- Per-profile effort within a group (for example, `max` on Claude but `high` on GLM). A later change can extend the value to a map if needed.
- Showing the effective effort in the chat UI. The SDK's `system/init` frame carries `effort`, and the Debug panel already shows it.
- Changing Claude Code's precedence or caps, or adding effort to profiles.

## Decisions

**D1 — Launch option, not environment.** Pass the group effort as SDK `Options.effort` (the `--effort` flag). Alternatives:
- Add `CLAUDE_CODE_EFFORT_LEVEL` to the profile env allowlist: this keys effort to the provider, not the role, and both the lead and a developer use the `default` profile in this repo.
- Inject `CLAUDE_CODE_EFFORT_LEVEL` per session: the CLI treats that variable as a hard override that also defeats `/effort` in the chat, which is more than a role default should do.

A flag is a launch default: settings caps still clamp it, and the user can still change it with `/effort` in a running chat.

**D2 — Resolve through `SessionTeams`, read per spawn.** Add `SessionTeams.effortFor(sessionId, groupId)`, returning the group's `effort` or `undefined`, using the same catalog lookup as `promptFor`. `ChatSessionManager` passes a `getEffort` getter to the driver beside `getSystemPromptAppend`, and the driver spreads `effort` into `Options` only when it is defined. Reading per spawn gives the spec's "running agent unchanged, next start uses the edit" behavior for free, and covers spawned members, human-created members, restarts, and resumes through one path. Alternative: persist effort on the session row at creation. Rejected because edits would never reach existing members, and the role prompt already established live re-reading.

**D3 — Placement in `Options`.** Put `effort` before `...launchOptions`. Profile launch options never carry `effort` today, so order is moot. But if a future operator-owned profile setting adds one, a later spread should be a deliberate decision, not an accident. The test asserts the getter's value reaches `Options.effort`.

**D4 — Invalid values warn.** An `effort` outside the five levels adds the warning `effort must be low, medium, high, xhigh, or max, got "<v>"; ignored` and leaves `effort` unset. This mirrors `onLimit`, not `approval`. Rejecting the file would also drop the group's role prompt, routing, and mail, a far larger failure than a missing tuning knob. `auto` and `ultracode` (accepted by `/effort`) are not valid. The SDK option's type has no such values, and leaving the key out already means "Claude Code decides".

## Risks / Trade-offs

- **The flag may not beat a persisted default.** `/effort <level>` can save a default to user settings. If the CLI ranked a settings default above `--effort`, the group value would silently lose. → The first implementation task checks precedence against the pinned CLI (flag vs `effortLevel`) and records the result. If the flag loses, stop and revisit D1 before writing code.
- **Gateway models may ignore effort.** GLM and MiMo gateways may drop or remap the effort parameter, so a `devs` group mixing providers gets uneven behavior. → Documented. Per-profile effort is a non-goal for now.
- **Environment override.** A server environment that sets `CLAUDE_CODE_EFFORT_LEVEL` (for example via `AGENTBOARD_CHAT_ENV`) overrides every group. → Documented as Claude Code precedence. Kawai does not strip it.
- **Mid-run `/effort` is not reflected back.** After a respawn, the group value applies again. → This is the intended behavior: the group sets the default at every start.

## Migration Plan

None. The key is optional, existing group files are unaffected, and no data is stored. Rollback is removing the key or reverting the code.
