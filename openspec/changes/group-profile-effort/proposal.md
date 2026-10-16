# Proposal

## Why

On 2026-10-16 the human asked for a Junior Dev profile on Claude Haiku 5.5 at `xhigh` effort, next to the group's GLM Flash members, which run at `low`.

Today `effort` is a group setting, so all members of a group launch at one level. Getting Haiku to `xhigh` would mean one of two things:
- raising every GLM Flash junior to `xhigh`, which is slower and spends more of a provider quota that already runs out;
- a second junior group that duplicates the role prompt.

## What Changes

- **Groups may set effort per profile.** Group frontmatter accepts an optional `profileEffort`: a single-line flow map from profile id to an effort level, for example `profileEffort: { haiku: xhigh }`.
  - When a member's agent starts and its session's profile has an entry, it launches at that entry's level. Otherwise it launches at the group's `effort`. With neither set, it launches with no effort from kawai, as today.
  - Spawned and human-created members are treated alike, by their session's profile.
  - Like `effort`, the value is read from the group file at each agent start, so edits reach only later starts.
- **Bad entries are warnings, never a rejected file.** These are reported as group warnings, and only the bad entry (or the whole key, if it is not a map) is ignored:
  - a value that is not a flow map;
  - a key that is not a profile id;
  - a level that is not one of the five;
  - a profile listed twice.
  An entry for a profile the group does not list still applies to members on that profile, and is also reported as a warning, since it is likely a typo.
- **Members shows per-profile effort.** It appears beside the group's effort.
- **Unchanged:**
  - `effort` keeps its meaning;
  - `CLAUDE_CODE_EFFORT_LEVEL` and a settings maximum still override or clamp what kawai passes;
  - an effort set inside a running chat lasts until that process ends;
  - the profile catalog (`profiles.json`) gains no field.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-teams`:
  - the group effort requirement resolves per-profile effort first;
  - new requirements cover `profileEffort` and its warnings.
- `team-workspace`: the Members tab shows per-profile effort.

## Impact

- **Code and tests:**
  - `src/server/team/groupFile.ts`: parse `profileEffort` into the group settings, with warnings.
  - `src/server/team/sessionTeams.ts`: `effortFor` takes the member's profile id.
  - `src/server/chat/ChatSessionManager.ts`: pass the session's profile at each agent start.
  - `src/shared/teamWorkspace.ts`: `TeamMemberRow` gains an optional `profileEffort` (additive).
  - `src/server/team/workspaceRead.ts`: project the new field.
  - `src/client/components/team/TeamMembersPanel.tsx`: show the per-profile levels.
  - The tests for each of these.
- **Docs:**
  - `AGENTS.md`: the group settings bullet.
  - `docs/routing/README.md`: the frontmatter example and the effort notes.
- **Not changed:**
  - no schema migration, tool, or profile-catalog change;
  - the read model gains one optional field.
- **Compatibility:** older servers ignore unknown frontmatter keys. A group file can therefore carry `profileEffort` before every server reads it; until then its members run at the group's `effort`.
