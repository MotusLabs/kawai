# Design

## Context

Approval policy is resolved in three places today:

- **Chats the human creates.** `NewSessionModal.tsx` seeds its Auto-approve checkbox from `settingsStore.defaultApprovalPolicy` (persisted in localStorage) and sends an explicit `approvalPolicy` on `session-create`. The server treats a missing value as manual (`ChatSessionManager.createSession`).
- **Spawned members.** `resolveSpawnApproval(groupApproval, teamDefault)` in `src/shared/spawnApproval.ts` returns `{ policy, source }`: the group key, then the team default, then manual. Its three callers are staffing (`staffing.ts` `approvalFor`), the dispatch preview (`groupDispatchPreview.ts`), and the Members read (`workspaceRead.ts`).
- **The team default.** `TeamApprovalDefaults` (`team_approval_defaults`, migration 22) is written only by `team-workspace-approval-default-set` from the Team page and read fresh at every spawn.

The New Session dialog already asks the server for the picked path's team groups (`useTeamGroups` → `GET /api/chat/groups?projectPath=`, served by `createTeamGroupRoutes`), which resolves the team for that path.

Both drivers already honour a session's stored policy (`decideApproval` in the Claude driver's `canUseTool`; `CodexRequests` for Codex). This change touches only where the starting policy comes from.

## Goals / Non-Goals

**Goals:**
- Exactly one stored default per team, used by both kinds of session.
- No repository file can make a chat auto when the human has not chosen auto for the team.
- Existing group files keep parsing, so no spawn starts failing.

**Non-Goals:**
- A global default for projects outside any team. Those seed manual, and the checkbox is still there.
- Changing the per-session header toggle, `/clear` carry-over, profiles, or the drivers' approval handling.
- Editing group files from the UI. The Members tab stays read-only for groups.

## Decisions

### D1. The team default is the only default; the Settings control goes away

Settings → Chat drops the Approval Policy radio group. In its place is one line pointing to the Team page's Members tab. `defaultApprovalPolicy` is removed from `settingsStore` (state, setter, sanitizer, persisted shape), and a value already stored in localStorage is ignored and not written back.

*Alternatives:* a team picker inside Settings, which duplicates the Team page control and still has no answer for teamless paths; or a global default plus per-team overrides, which brings back two layers of default. The human chose removal.

*No carry-over:* turning a browser value into a team default would let one browser's old setting grant auto to every spawned member of a team. Only an explicit Team page action sets it.

### D2. The dialog seeds from the groups lookup it already makes

`GET /api/chat/groups` adds `approvalDefault: 'manual' | 'auto' | null` for the resolved team: null when the path has no team or the team never set one. `useTeamGroups` returns it beside the groups, and a failed or malformed response yields null.

The dialog keeps an `autoApproveTouched` flag, reset on every open. While the flag is untouched, each lookup result sets the checkbox to `approvalDefault === 'auto'`; once the user toggles it, results no longer change it. A caption under the checkbox shows "Team default: auto", "Team default: manual", or "No team default". Create still sends the visible checkbox state as an explicit `approvalPolicy`.

*Alternative:* let the server apply the team default when `approvalPolicy` is absent. Rejected: it changes the meaning of an existing wire field ("absent = manual" is specified and relied on by older clients), and the session could start on a policy the user never saw in the dialog.

### D3. Tighten-only resolution lives in `resolveSpawnApproval`

```
group = manual             → manual, source 'group'
team default set           → team default, source 'team'
otherwise                  → manual, source 'built-in'
```

The result also gains `ignoredGroupAuto: boolean` (the group says `auto` and resolution came from somewhere else). All three callers go through this one function, so staffing, the dispatch preview, and the Members tab cannot disagree.

| group key | team default | policy | source | ignoredGroupAuto |
|---|---|---|---|---|
| — | — | manual | built-in | no |
| — | manual | manual | team | no |
| — | auto | auto | team | no |
| manual | any | manual | group | no |
| auto | — | manual | built-in | yes |
| auto | manual | manual | team | yes |
| auto | auto | auto | team | yes |

The table above is the oracle for unit tests: `spawnApproval.test.ts` covers every row. As a property, for every input `policy === 'auto'` implies `teamDefault === 'auto'`.

*Alternatives:*
- **Reject `approval: auto` at parse time.** This makes the group file invalid, so its group stops spawning, which is far worse than starting on manual.
- **Auto needs team opt-in.** This yields the same policies as the table. The only difference is labeling the source, and "team default" is the honest label, since the group key decided nothing.
- **Keep auto allowed.** This leaves the privilege inversion described in the proposal.

### D4. The ignored key is reported in two places

- **Group warning.** `parseGroupFile` keeps accepting `approval: auto` (it still sets `group.approval`). It adds the constant warning ``approval: auto has no effect; auto comes only from the team default (Team page → Members)``. It is constant because the parser does not know the team. Members rows already render group warnings.
- **Team-level notice.** The Members read adds `autoRequestedBy: string[]`: the group ids with `approval: auto`, listed only while the team default is not auto. `TeamApprovalDefaultControl` names them under the control: "devs, reviewers ask for auto; set the default to auto to grant it". The list empties after a save sets auto, because every committed default change already re-pushes the workspace read to all open views.

### D5. The tracked group files stop asking for auto

`junior-devs.md`, `middle-devs.md`, `senior-devs.md`, and `reviewers.md` drop `approval: auto`. The comment in `reviewers.md` explaining why Codex reviewers need auto is rewritten: it now says to set the team default to auto. Untracked or user-level group files (for example `.kawai/groups/reviewers-glm.md`, or groups defined outside this repository) are the human's and are not edited. The Members notice names them.

## Risks / Trade-offs

- **[Spawns fall back to manual after the upgrade and stall on approval cards nobody watches]** → The human sets the team default to auto before upgrading. The Team page control and its table already exist, so this works on the current build. The Members notice names any group still asking for auto, and plan stall alerts catch a stuck change.
- **[The checkbox flips after the dialog opens, because the lookup is asynchronous]** → It only flips while untouched. The caption shows the source, and create sends exactly what is shown.
- **[The constant warning stays on groups that set `auto` even when the team default is auto]** → This is intended: the key is redundant either way, and removing it clears the warning.
- **[Old browser tabs from before the upgrade still send their last Settings value as `approvalPolicy`]** → This is a human-created chat, and the human can see the checkbox. It matches today's behavior and disappears on reload.

## Migration Plan

1. Before deploying, set the team default to auto on the Team page for any team whose groups rely on `approval: auto`.
2. Deploy. Group files keep parsing, and groups with `approval: auto` resolve from the team default.
3. **Rollback:** the old build reads the same `team_approval_defaults` row. With the team default at auto and the tracked `approval: auto` lines removed, the old resolution still yields auto. No data migration runs in either direction.
