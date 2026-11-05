# Tasks

## 1. Tighten-only spawn resolution

- [x] 1.1 Change `resolveSpawnApproval` (`src/shared/spawnApproval.ts`) to the design D3 order (group `manual`, then team default, then built-in manual) and add `ignoredGroupAuto` to its result; rewrite `src/shared/__tests__/spawnApproval.test.ts` as a table test of all seven D3 rows plus the property "policy is auto only when the team default is auto" over every input combination; verify with `bun run test src/shared/__tests__/spawnApproval.test.ts`.
- [x] 1.2 Update staffing tests (`src/server/__tests__/teamStaffing.test.ts`): replace the "Explicit auto beats a manual default" case with the group-auto cases (manual default, no default, auto default). Retarget their `@covers` annotations to `team-worktree-staffing › A group's approval key can only tighten its spawned members' policy › …` and the spawn ones to `… › A member is spawned into an unstaffed worktree › …`, and annotate "A group file cannot raise the default". Verify with `bun run test src/server/__tests__/teamStaffing.test.ts src/server/__tests__/teamApprovalDefault.integration.test.ts src/server/__tests__/teamApprovalDefaults.test.ts`.
- [x] 1.3 Make the dispatch preview (`groupDispatchPreview.ts`) show the tighten-only policy and source for a group with `approval: auto`; add a case to `src/server/__tests__/taskDispatchPreview.test.ts` (team default manual, group auto → manual from the team default); verify that file passes.

## 2. Group warning and the Members notice

- [x] 2.1 In `parseGroupFile` (`src/server/team/groupFile.ts`), keep accepting `approval: auto` and add the constant D4 warning; update the header comment. Add a case to `src/server/__tests__/teamGroupFile.test.ts` asserting the file still parses, `approval` is `auto`, and the warning is present, plus a case asserting `approval: manual` produces no warning; verify that file passes.
- [x] 2.2 Add `autoRequestedBy` to the Members read (`workspaceRead.ts`) and its shared type: group ids with `approval: auto`, listed only while the team default is not auto. Extend `src/server/__tests__/teamWorkspaceRead.test.ts` (no default → listed; auto default → empty; a group with the key shows source `team` or `built-in`, never `group`) and annotate the scenarios "An ignored auto key is a warning" and "A manual key is shown as the group's own policy"; verify that file passes.
- [x] 2.3 Update `TeamApprovalDefaultControl.tsx`: the copy states the wider scope (spawned members of groups without `approval: manual`, and chats the human creates), and the control names the groups in `autoRequestedBy`. Extend `src/client/__tests__/teamApprovalDefaultControl.test.tsx` and annotate "Groups asking for auto are named next to the control" and "The notice clears once the default is auto"; verify that file and `src/server/__tests__/teamWorkspaceConnections.test.ts` pass.
- [x] 2.4 Update the Members-tab bullet in `docs/architecture/team-page.md` and the group-settings and worktree-staffing bullets in `docs/architecture/tasks.md` to describe tighten-only resolution, the warning, and the notice; verify with `grep -n "approval" docs/architecture/team-page.md docs/architecture/tasks.md` showing no remaining "group key, then team default" wording.

## 3. The New Session dialog seeds from the team default

- [ ] 3.1 Add `approvalDefault` (`'manual' | 'auto' | null`) to the `GET /api/chat/groups` response in `createTeamGroupRoutes`: null for a path with no team or a team without a default. Extend `src/server/__tests__/teamGroupRoutes.test.ts` with all three values; verify that file passes.
- [ ] 3.2 Return `approvalDefault` from `useTeamGroups` (null on fetch failure or a malformed value). In `NewSessionModal.tsx`, seed Auto-approve from it under an `autoApproveTouched` flag reset on open, and add the source caption (design D2). Rewrite the approval cases in `src/client/__tests__/newSessionModal.test.tsx` and annotate every `chat-sessions › New chats start from their team's default approval policy › …` dialog scenario (seed, override, no default, re-seed vs touched, stored browser value ignored); verify that file passes.
- [ ] 3.3 Retarget the `@covers` in `src/server/__tests__/indexHandlers.test.ts` to "A create request without a policy stays manual", and cover "A team default change does not touch existing sessions" with a server test that sets the team default while a team chat exists and asserts the chat's stored policy is unchanged; verify both tests pass.

## 4. Remove the Settings control

- [ ] 4.1 Remove `defaultApprovalPolicy` and its setter from `settingsStore.ts`, including the persisted-shape sanitizer, so a stored value is dropped on rehydrate and never written back. Add a `src/client/__tests__/settingsStore.test.ts` case that rehydrates storage holding `defaultApprovalPolicy: 'auto'` and asserts the state and the next persisted write omit it; verify that file passes.
- [ ] 4.2 Remove the Approval Policy control from `ChatSettings.tsx` and its draft state from `SettingsModal.tsx`, and add the one-line pointer to the Team page's Members tab. Update `src/client/__tests__/settingsModal.test.tsx` to assert no approval radio group and the pointer text, annotated "Settings has no approval control"; verify with that file and `bun run typecheck`.
- [ ] 4.3 Update the approval-policy bullet in `docs/architecture/chat.md` (the default now comes from the team; Settings has none); verify with `grep -n "Settings" docs/architecture/chat.md` showing no reference to a Settings approval default.

## 5. Tracked group files and integration

- [ ] 5.1 Remove `approval: auto` from `.kawai/groups/junior-devs.md`, `middle-devs.md`, `senior-devs.md`, and `reviewers.md`, and rewrite the `reviewers.md` comment to say Codex reviewers need the team default set to auto; leave untracked group files alone. Verify with `git grep -n "^approval: auto" -- .kawai/groups` printing nothing, and that the group-file tests reading `.kawai/` (if any, per their `@reads` headers) pass.
- [ ] 5.2 Check that every scenario in this change's delta specs has a `@covers` annotation. The removed requirements' scenarios keep their transitional annotations, because the guard requires every scenario still in the main specs to stay covered until this change archives. Verify with `bun run test scripts/__tests__/specCoverageGuard.test.ts` passing and with each delta scenario name found by `grep -rn` under `src`.
- [ ] 5.3 Walk through the UI with Playwright after `bun run build`. With team default auto, New Session for a path in the team shows Auto-approve checked with "Team default: auto". A teamless path shows it unchecked. Settings → Chat shows no approval control. The Members tab names a group with `approval: auto` until the default is set to auto. Record the screenshots in the result.
- [ ] 5.4 Run `bun run check` on the clean committed tree and verify it records a pass.

## Workflow follow-up

- Before deploying, the human sets the team default to auto on the Team page for every team whose groups relied on `approval: auto` (design Migration Plan).
- Archive the change after review. At archive, delete the transitional annotations naming "Users configure the default approval policy for new chat sessions" and "A member is spawned when none is available" (the guard fails until they are gone), and confirm every ADDED or MODIFIED scenario left in the main specs has a covering annotation.
