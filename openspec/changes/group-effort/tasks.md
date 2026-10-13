# Tasks

## 1. Precedence check

- [x] 1.1 With the pinned Claude Code CLI, confirm that `--effort` beats a settings `effortLevel` default and that `CLAUDE_CODE_EFFORT_LEVEL` and a settings maximum still override or clamp it. One way: launch a throwaway SDK query with `effort: 'high'` under a temporary settings file holding `effortLevel: low`, and read `effort` from its `system/init` frame. Record the outcome as a note in `design.md` D1. If the flag loses, stop and revisit D1 before continuing.

## 2. Group file

- [x] 2.1 In `src/server/team/groupFile.ts`, add the optional `effort?: EffortLevel` to `GroupDefinition` (low/medium/high/xhigh/max, using the SDK-independent type or a local literal union). Parse it in `parseTaskSettings`; an invalid value adds the D4 warning and leaves `effort` unset. Update the header comment. Verify with new cases in `src/server/__tests__/teamGroupFile.test.ts`: each valid level is parsed, absent means `undefined`, quoted values work, an invalid value gives a warning plus `undefined` while the rest of the file still parses, and `auto` is invalid.
- [x] 2.2 Confirm that the invalid-effort warning reaches the catalog warnings with its file prefix, as served by the team groups route. Verify with a `groupCatalog` or route test asserting the prefixed warning.

## 3. Launch plumbing

- [x] 3.1 Add `SessionTeams.effortFor(sessionId, groupId)` in `src/server/team/sessionTeams.ts`, using the same catalog lookup as `promptFor`. It returns `undefined` with no group, an unknown group, or no `effort`. Verify in `src/server/__tests__/teamSessionTeams.test.ts`, including that a file edit (stamp change) returns the new value on the next call.
- [x] 3.2 Give `ChatSessionDriver` an optional `getEffort` option, read when each spawn's `Options` is built. Spread `effort` only when it is defined, placed before `...launchOptions` (design D3). Verify in `src/server/__tests__/chatSessionDriver.test.ts`: the query factory receives `options.effort` when the getter returns a level, the key is absent when it returns `undefined`, and a respawn after the getter's value changes gets the new value.
- [x] 3.3 Wire `getEffort: () => this.teams.effortFor(record.sessionId, this.records.get(record.sessionId)?.groupId)` in `ChatSessionManager` beside `getSystemPromptAppend`. Verify with a manager-level test: a session in a group with `effort: max` launches with `max`, and a session without a group launches with no `effort`.

## 4. Documentation and checks

- [x] 4.1 Document `effort` in `CLAUDE.md` (the group-settings bullet: values, per-start read, warning on invalid, Claude Code precedence) and in `docs/routing/README.md`'s frontmatter example. Verify by reading the diff.
- [x] 4.2 Run `bun run lint && bun run typecheck && bun run test`; all pass.
- [x] 4.3 End-to-end check without browser e2e (never `test:e2e` against the live server). Start a dev server on a spare port with a scratch team whose group sets `effort: max`, create a member, and confirm its Debug panel or wire log shows `system/init` with `effort: "max"`. Then edit the file to `medium`, restart the agent, and confirm the new value appears. Record the result as a task journal or PR note.
  - Result (2026-10-13, Claude Code 2.1.296): `system/init` carries no `effort` for SDK sessions, and the host login had expired, so the check drove `ChatSessionManager` directly with the real SDK in a scratch git repo and read the spawned CLI's argv (no prompt, so no model call). A `lead` member (`effort: max`) launched with `--effort max`. A `devs` member without `effort`, and a session without a group, launched with no `--effort`. Editing the file to `medium` left the running process unchanged. After archive, restore, and start, the lead launched with `--effort medium`.

## Workflow follow-up

- Archive the change after merge (`openspec-archive-change`).
- In this repo, set `effort: max` in `.kawai/groups/lead.md` and `effort: medium` in `.kawai/groups/devs.md` once the feature ships.
