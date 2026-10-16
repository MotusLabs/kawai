# Design

## Context

Group effort (`effort` in group frontmatter) reaches the agent launch through one path: `ChatSessionDriver`'s `getEffort`. At each agent start, `ChatSessionManager` calls `SessionTeams.effortFor(sessionId, groupId)`, which reads the group from the team catalog, re-read whenever its files' stamp changes.

The session's profile is already on its record (`claudeProfileId`, stored as `profile_id`, `default` when unset). The group parser (`groupFile.ts`) accepts flat `key: value` lines, each optionally holding one single-line flow value (`[a, b]` or `{ k: v }`, scalars only). It ignores unknown keys, so older readers skip new settings.

## Goals / Non-Goals

**Goals:**
- One group can run different profiles at different efforts.
- The per-profile level is resolved the same way for spawned and human-created members.
- Bad entries degrade alone, never rejecting the file.

**Non-Goals:**
- Per-session effort controls in the UI.
- An effort field in the profile catalog.
- Changing how Claude Code's settings or `CLAUDE_CODE_EFFORT_LEVEL` override or clamp the launch effort.

## Decisions

### D1. A separate `profileEffort` key

The new setting is a separate key, `profileEffort: { <profile id>: <level>, ... }`.

Rejected: a map form of `effort` (`effort: { glm-flash: low, haiku: xhigh }`).
- An older server would warn about the map and drop the whole group effort.
- A map-only form has no fallback level. A `default` key cannot serve as one, because `default` is already a profile id.

With a separate key:
- `effort` stays the fallback;
- older readers ignore the new key;
- a file can carry both before every server reads them.

Rejected: an `effort` field on profile catalog entries.
- Effort is a role decision: the lead and a junior may share a profile but not a level.
- The catalog's controlled fields are provider routing and model mapping only.

### D2. Resolution at each agent start

`effortFor(sessionId, groupId, profileId)` returns, in order:
1. `profileEffort[profileId]` when the group sets that entry;
2. otherwise the group's `effort`;
3. otherwise undefined.

`ChatSessionManager` passes the record's `claudeProfileId`, or `default`, read at each start just like the group id. Restarts, resumes, and respawns therefore use the file and profile as they are at that start. A spawned member's profile is fixed at creation by routing, so it resolves the same way as a human-created one.

### D3. Warnings, entry by entry

Every problem is pushed to the group's `warnings`, which the Members tab and the groups route already show.

| Problem | Warning | What is ignored |
|---|---|---|
| A value that is not a `{ k: v }` flow map, including a list or a parse error | names the key | the whole key |
| A key failing `PROFILE_ID_PATTERN` | names the key | that entry |
| A level outside the five | names the profile and the value | that entry |
| A profile listed twice | names the profile | the second occurrence; the first stays |
| A profile the group does not list | says it applies only to members on that profile (likely a typo) | nothing: the entry is kept |

A group that lists no profiles lists `default` for the last check. Human-created members can run on any profile, so an entry for an unlisted profile still has an effect, but it is usually a mistake.

### D4. Members shows the levels

`TeamMemberRow` gains an optional `profileEffort: Record<string, GroupEffort>`, holding only the valid entries. The panel's Effort row shows the group level, followed by each override in the group's profile order, then any unlisted profiles alphabetically. For example:

```
low · haiku: xhigh
```

With no group effort, the row starts with the existing "Claude Code settings decide". The row is additive on the wire: an older client ignores the new field.

## Risks / Trade-offs

- **A model may not support the requested level.** Claude Code passes the level to the model, and a gateway model may ignore effort, as `docs/routing/README.md` already notes. A Claude model that does not support a level is the CLI's concern. A host CLI probe on 2026-10-16 ran Claude Haiku 5.5 at `--effort xhigh` successfully.
- **Two keys describe one concept.** This is mitigated by the docs and the Members row, which shows the result.
