## 1. Parsing

- [x] 1.1 `src/server/team/groupFile.ts`: parse the optional `profileEffort` key into `GroupSettings.profileEffort?: Record<string, GroupEffort>`, holding valid entries only.
  - Use `parseFlow`.
  - Every problem in design D3 is a warning; the file is never rejected.
  - Update the header comment's key list.
- [x] 1.2 Warn when an entry names a profile the group does not list, keeping the entry (D3). A group without `profile`/`profiles` lists `default`.

## 2. Launch

- [x] 2.1 `SessionTeams.effortFor(sessionId, groupId, profileId)` returns `profileEffort[profileId]`, else the group's `effort`, else undefined (D2).
- [x] 2.2 `ChatSessionManager`'s `getEffort` passes the record's current `claudeProfileId`, or `default`, read at each agent start like the group id.

## 3. Members tab

- [x] 3.1 `TeamMemberRow` gains an optional `profileEffort` in `src/shared/teamWorkspace.ts`, and `workspaceRead` projects it.
- [x] 3.2 `TeamMembersPanel`'s Effort row shows the group level, then each override: listed profiles in the group's profile order, then unlisted ones alphabetically, e.g. `low · haiku: xhigh` (D4).

## 4. Tests and docs

- [x] 4.1 Unit tests:
  - the parser: valid entries; each warning case in D3; an unlisted profile; a group without `effort`;
  - `effortFor`: an entry wins; fallback to `effort`; none; the `default` profile;
  - the launch path for a spawned and a human-created member, following the existing effort tests in `teamSessionTeams.test.ts` and `chatSessionDriver.test.ts`;
  - an edited entry reaching only the next start;
  - the Members projection and the panel's Effort row.
- [x] 4.2 Docs:
  - `AGENTS.md`: the group settings bullet (the `effort:` entry);
  - `docs/routing/README.md`: the frontmatter example and the effort notes.
- [x] 4.3 `openspec validate group-profile-effort --strict` and `bun run lint && bun run typecheck && bun run test` pass.
