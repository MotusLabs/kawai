## Why

Five controls decide whether a chat's tool uses are auto-approved:
- the Settings "Approval Policy" (browser-local, chats the human creates);
- the New Session checkbox;
- the chat header toggle;
- a group file's `approval:` key;
- the Team page team default.

The two "defaults" answer the same question for two kinds of session, live in different stores, and give no sign of which one applies. Turning on auto in Settings looked like it should cover spawned members, and it never does. The Settings value also lives only in one browser, so a second browser or a cleared cache silently starts chats on manual.

There is also a privilege inversion. The team default is human-only by design (`team-approval-default` D3/D4: no agent tool writes it). But a group file's `approval: auto` outranks it, and group files are repository files that agents can edit and commit.

## What Changes

- **One default per team.** The server-stored team default is the only default approval policy. It seeds the New Session dialog's Auto-approve checkbox for the team that owns the picked project path. A path with no team, or a team with no default, seeds manual. Only the human sets the default, from the Team page.
- **BREAKING (UI):** Settings → Chat loses its Approval Policy control. In its place, a line says the default is set per team on the Team page's Members tab. The browser-stored `defaultApprovalPolicy` is dropped and not carried over.
- **BREAKING (behavior): group `approval:` keys can only tighten.** `approval: manual` still overrides the team default. `approval: auto` no longer grants auto: the group follows the team default, and the group row shows a warning that the key has no effect. Today's groups that set `approval: auto` spawn on manual until the human sets the team default to auto.
- The Members tab names the groups whose `approval: auto` is ignored, next to the team default control, so the human can restore auto in one action.
- The tracked group files in `.kawai/groups/` stop setting `approval: auto`.
- Unchanged: the chat header's per-session toggle, `/clear`/`/reset`/`/new` carrying the previous chat's policy, a create request without a policy starting manual, and profiles contributing no approval behavior.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `chat-sessions`: the default for chats the human creates comes from the team default of the picked path, not from Settings; Settings no longer has an approval control.
- `team-worktree-staffing`: the team default also seeds human-created chats; spawn resolution becomes tighten-only, so a group's `approval: auto` never grants auto.
- `team-workspace`: the Members tab describes the team default's wider scope, shows ignored `approval: auto` keys as warnings, and shows the effective source under tighten-only resolution.

## Impact

- `src/shared/spawnApproval.ts`: resolution and source labels; the callers `staffing.ts`, `groupDispatchPreview.ts`, and `workspaceRead.ts` pick the change up through it.
- `src/server/team/groupFile.ts`: an `approval: auto` warning. The key still parses, so existing files stay valid.
- `GET /api/chat/groups` (`createTeamGroupRoutes`, `src/server/bootstrap.ts`): adds the team's `approvalDefault` (manual, auto, or null).
- Client: `useTeamGroups.ts` and `NewSessionModal.tsx` (seeding); `settingsStore.ts`, `SettingsModal.tsx`, and `ChatSettings.tsx` (removal); `TeamApprovalDefaultControl.tsx` and the Members panel (wording and ignored-key notice).
- `.kawai/groups/*.md` (tracked files), and the approval bullets in `docs/architecture/`.
- No schema migration: `team_approval_defaults` (migration 22) is reused unchanged.
