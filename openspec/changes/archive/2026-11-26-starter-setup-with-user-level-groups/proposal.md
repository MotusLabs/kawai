# Proposal

## Why

The New Session dialog shows its missing-groups notice whenever a project has
no group file of its own, even when the dialog's group picker lists the
user-level groups of `~/.kawai/groups/`. A team whose groups live at the user
level therefore reads "This project has no team groups yet" above a populated
picker, and the notice's link leads to Set up team, whose starter `lead.md`
and `reviewers.md` would replace the user-level groups of the same ids for
that project with no warning in the preview.

## What Changes

- **The notice follows the group picker**: the New Session dialog shows the
  missing-groups notice only when the team's setup action would be offered
  and the picker offers no group for the project path. A project with no
  group files of its own but user-level groups shows no notice.
- **The preview names the groups it would replace**: the Set up team preview
  carries one warning per starter group whose id names a user-level group
  file, naming that file and saying the written file replaces that group for
  this project. Confirm stays available.
- Unchanged: when the Members tab offers Set up team, what it writes, its
  refusals, and the wire shapes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `team-setup`: the New Session notice is hidden when the dialog's group
  picker offers a group; the setup preview warns about each starter group that
  would replace a user-level group.

## Impact

- Server: `src/server/team/teamSetup.ts` (`setupPreview` gains the
  replacement warnings) and the `team-workspace-setup-preview` handler in
  `src/server/team/workspaceConnections.ts`.
- Client: `src/client/components/NewSessionModal.tsx` (the notice's
  condition). The preview already renders every warning, so
  `TeamSetupControl` needs none.
- Tests: `src/client/__tests__/newSessionMissingGroups.test.tsx` (its fixture
  ties setup availability to an empty picker; add the user-level case),
  `src/server/__tests__/teamSetup.test.ts`,
  `src/client/__tests__/teamSetupControl.test.tsx`, and
  `tests/e2e/team-setup.spec.ts`, whose server inherits the developer's HOME
  and so needs a home without user-level groups to keep showing the notice.
- Docs: `docs/architecture/team-page.md` (the Members bullet).
- Overlap: `team-workspace-redesign` (not started) renames Members to Agents
  and moves the setup control; whichever archives second rebases.
- No new dependency; nothing leaves the machine.
