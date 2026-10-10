# Proposal

## Why

Teams mix providers: a group of devs may run on Claude, GLM, and MiMo at once. Which agent should pick up the next message — and what happens when a provider hits its limit mid-task — is a policy the user wants to own. kawai's usage data cannot answer it alone: it is in memory only and wrong or absent for gateway-routed profiles. So routing needs a user-defined rule and a provider-independent limit signal, and a task interrupted by a limit should be parked, released, or handed off instead of silently stalling.

Depends on `agent-teams` and `team-tasks`.

## What Changes

- **Mixed profiles per group.** Group frontmatter `profiles: [claude, glm, mimo]` lists the profiles members may use, replacing the single `profile` of `team-tasks` (a single value stays valid). Spawned members get the profile the routing decision chose.
- **User-level routing rules.** `~/.kawai/routing/<group>.ts` exports a rule with `route(ctx)` and optional `onLimit(event)`. Rules are never read from project `.kawai/` directories.
- **Rule runtime.** Rules run in a Worker with an empty environment; a rule may declare `env: [...]` to receive only those variables. Rules load at server start and on a **Reload routing rules** action in the web UI; file changes alone never apply.
- **Route contract.** kawai pre-filters candidates (idle members, spawn slots per allowed profile) and passes them with message metadata (priority, sender group, tags, worktree, task id — never the body) and per-profile usage and limit history. `route` may be async; it returns pick / hold / default. Decisions are re-validated at claim, time-boxed, and serialized per group; failure or timeout falls back to the built-in strategy.
- **Built-in strategy.** Without a rule, the group's frontmatter `strategy` applies (`first-available` default, or `profile-order`), always skipping profiles in cooldown.
- **Limit events.** kawai records per-profile limit events from Claude Code's classified errors (final assistant `rate_limit` / `billing_error` / `overloaded`, and retry frames with status and message) and persists them for 24 hours.
- **Cooldown per profile.** A profile with a final limit event is in cooldown (default one hour, or the provider's reset time when known; rules may define their own). Cooldown applies across all groups, never to a whole group.
- **onLimit outcomes.** When a claimed message's turn fails on a limit: **park** (keep it on the same agent and schedule a resume at reset), **release** (back to the group queue), or **forward** (hand off to a group or agent with a handoff package). Default: park if the agent made progress and the reset is within `parkIfResetWithin` (default 3h); forward if progress and the reset is later; release if no progress. Configurable in group frontmatter and by `onLimit`, and overridable by a manual **Hand off** action in the UI.
- **Handoff package.** Forwarded mail carries the task header, journal, thread, a progress digest (tool calls since claim, files touched, last error), the commit at claim time, and an instruction to reconstruct context from the working directory before acting. The released agent is notified of the handoff once its profile recovers.
- **Parked agents** are excluded from group pickup and shown as paused with the reason and resume time. Urgent direct mail to an agent whose profile is in cooldown is refused back to the sender with the reset time.

Non-goals: switching a running session's profile; real usage accounting for third-party providers; rules from project files; giving rules the message body.

## Capabilities

### New Capabilities

- `team-routing-rules`: per-group profile lists, the built-in strategy, user-level TypeScript routing rules, their isolated runtime, reload, and the route contract.
- `profile-limit-handling`: limit event capture and persistence, per-profile cooldown, park / release / forward outcomes, handoff packages, parked-agent state, and refusing urgent mail to cooling profiles.

### Modified Capabilities

None in main specs. Extends `team-worktree-staffing` (spawn profile chosen by routing) and `agent-mailbox` (group pickup consults routing) once those land.

## Impact

- Server: `src/server/team/routing/` (rule loader, Worker host, context builder, built-in strategies), limit-event capture in `ChatSessionDriver.ts` (from `api_retry` and assistant `error`), dispatcher integration, `db.ts` (`profile_limit_events`; parked fields on `team_messages`).
- Shared: rule contract types published as a `.d.ts` for rule authors; parked status and handoff events.
- Client: Reload routing rules action with load errors, paused indicator, Hand off action, rule decision log in the mailbox view.
- Security: rules are user code running on the server; the empty-env Worker and manual reload bound what a planted file can do.
