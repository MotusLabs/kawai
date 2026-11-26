# Design

## Context

See [proposal.md](proposal.md). The group route returns the picker options and setup availability in one response. The picker uses parsed groups from the user and project catalogs. The setup offer uses the presence of a project group file. The workspace preview already returns an array of displayable warnings.

## Goals / Non-Goals

Use the picker’s options to decide when the chat notice is useful. Warn about each starter group that would take precedence over a same-named user-level file.

Keep the project setup offer, pinned-directory writes, refusal rules, templates, and wire fields under the existing team-setup contract. Keep fixture changes within the team-setup browser spec.

## Decisions

### The notice uses the current chat lookup

Use the current-path setup answer and the same options that render the group picker in `NewSessionModal`. The neutral “No group” choice contributes zero. Retain the current path invalidation during lookup and the existing link, chat creation, and terminal behavior.

Using this projection makes the notice reflect groups the human can actually select. File presence continues to answer setup availability. Changing that availability would change the Members action even when a project can safely receive starter files.

### Preview warnings use the actual user-level file names

Resolve the user-level directory with the group catalog’s home resolution. Carry the manager’s existing home override through the preview handler and resolve the project through the current team scope. For each starter id, check whether its exact `<id>.md` path refers to a file. Read metadata only. A malformed file with the matching name qualifies. A directory at that name does not designate a group file. A missing directory or unreadable metadata yields no match for the affected path.

Append one warning per match in starter order to the existing warnings. For example, “lead.md replaces ~/.kawai/groups/lead.md for this project.” Keep the preview informational and let the existing Confirm control handle it. A check based on parsed catalog provenance would omit malformed files. The project write continues to use its exclusive file creation and directory pins.

### Use an owned browser fixture

Run the existing team-setup walkthrough with the repository’s CI development fixture and the existing `ServerProcess` helper. The app under test gets a fresh temporary HOME, repository, database, private tmux socket, and spare loopback port. Just after proving the empty-home notice and Members link, add a synthetic user-level file under that HOME. Verify that the picker offers it and the notice is gone, then open the preview and confirm after seeing the warning. Check that the user-level file keeps its original bytes and that the three project files match the templates and remain untracked.

Keep the shared Playwright configuration and workflow as they are. The fixture-only opt-in lets the current CI lister find the spec. Use a fresh build in a disposable worktree and test through the same fixture path with its own temporary run state.

### Acceptance oracles

The tables describe observable results. `*` means any value.

| ID | Dialog kind | Setup answer for the displayed path | Offered group count | Notice |
| --- | --- | --- | --- | --- |
| N1 | chat | available | zero | shown |
| N2 | chat | available | one or more | hidden |
| N3 | chat | unavailable | * | hidden |
| N4 | chat | pending, failed, or for another path | * | hidden |
| N5 | terminal | * | * | hidden |

An unparsed user-level file supplies no option, so N1 still applies when it is the only group file. Use route evidence with real files for the parsed and unparsed cases and exercise the rendered picker and notice with independent setup and group inputs. Deleting the picker count condition must fail N2.

| ID | Candidate at a starter id | Replacement warnings for that id |
| --- | --- | --- |
| W1 | same-named, valid user-level file | one, naming the file and the project replacement |
| W2 | same-named, malformed user-level file | one, with the same wording |
| W3 | absent, including a missing groups directory or only other ids | zero |
| W4 | a directory at the matching path | zero |

When more than one starter matches, apply the rows independently. Missing-worker warnings still appear. Exercise W1 and W2 through the real workspace preview handler with the fixture home override and check Confirm with the resulting warning shape. Dropping the home override or replacing the file check with a parsed-groups check must fail the corresponding composed tests. Both tables use the existing cleanup and fixture ownership.

- **P1 (I1)**. Seed `0x57A27`, eight cases covering the prestates of present or absent project groups and the valid, malformed, unrelated, and absent user file cases. Observing the preview preserves the project-derived offer, target, starter manifest, and raw files. Use the actual setup availability and preview. Existing write, refusal, and race tests continue to witness the write boundary.
- **P2 (I2)**. Seed `0x57A28`, sixteen cases covering all subsets of the three starter names, each with valid and malformed contents. Include an unrelated name and keep expected warnings as literal fixture expectations. Use the preview result, assert the matching names exactly once in starter order, and compare user and project fixture state before and after. Use deterministic local fixtures with the existing test tooling.

## Risks / Trade-offs

- A previous project’s answer could mislead the human during a path change. The notice continues to depend on the matched current response.
- A preview reports the observed files when requested. Confirmation still checks the target at write time through the existing pinned path.
- Team Workspace Redesign also moves the Members setup control. Reconcile the later branch’s UI location, annotations, and delta when integrating. Keep the current Members behavior for this change.

## Implementation contract

### Acceptance
- A1: The New Session modal renders N1–N5 using the offered picker options for the current project path. An offered user-level group hides the notice. With setup available and only malformed user-level files, the notice is visible. The notice link and chat creation behave as specified.
- A2: The workspace preview reports W1–W4, names each affected file once, preserves the missing-worker warnings, and leaves Confirm usable.
- A3: The change’s four added scenarios have literal coverage, and the existing five notice scenario titles retain their coverage. The isolated browser walkthrough shows the empty-home notice, the hidden notice with an offered user-level group, the collision warning, and the untracked template writes.

### Invariants
- I1: The project group files alone govern setup availability. The existing project-write safeguards, refusals, target, template bytes, and wire fields hold.
- I2: Replacement warnings are derived from matching user-level file metadata under the catalog’s effective home. Preview reads leave user and project group files intact.

### Scope
- openspec/changes/starter-setup-with-user-level-groups/**
- src/client/components/NewSessionModal.tsx
- src/server/chat/ChatSessionManager.ts
- src/server/team/teamSetup.ts
- src/server/team/workspaceConnections.ts
- src/client/__tests__/newSessionMissingGroups.test.tsx
- src/client/__tests__/teamSetupControl.test.tsx
- src/server/__tests__/teamSetup.test.ts
- src/server/__tests__/teamSetupConnections.test.ts
- src/server/__tests__/teamGroupRoutes.test.ts
- tests/e2e/team-setup.spec.ts
- docs/architecture/team-page.md

### Verification
- V1: The notice, group route, preview, setup control, and existing project write tests pass through the repository runner. P1 and P2 and the described wiring negative controls are recorded with exact test titles.
- V2: Strict OpenSpec validation and literal citation preflight pass. Record a clean committed `bun run check --full-properties` using that commit’s `.bun-version` and the current result verifier status.
- V3: Build the exact candidate and run `tests/e2e/team-setup.spec.ts` through the CI development-fixture path on disposable state. Record the exact run, including the served head. Use the fixture step in PR CI before final review.

### Excluded
- X1: Changes to templates, group parsing or precedence, run semantics, agent tools, message fields, the Members tab layout, and the redesign.
- X2: Live data or HOME, OS or shared browser configuration changes, and the `bun run test:e2e` entry point.
