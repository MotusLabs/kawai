# Proposal

## Why

A project new to kawai has no team: role groups exist only where someone has
hand-written `.kawai/groups/*.md`, so the first Team page a human sees is
empty, and nothing in kawai can create one. And when a team does review work,
nothing guarantees the reviewer runs a different model than the author: the
per-model reviewer groups in use today rely on the lead's prompt picking the
right group, and the `author-profile:<id>` tags plan executions put on review
mail only matter when a user-level routing rule reads them.

## What Changes

- **Set up team** on the Team page: when the team's main checkout has no
  group files of its own, the Members tab offers a starter team, previews its
  three groups and their staffing, and on the human's confirmation writes
  them as ordinary editable files into `<main-checkout>/.kawai/groups/`:
  - `lead`: Team Lead, one worker on `codex-sol`;
  - `devs`: Dev, one worker on `opus` and one on `codex-sol`;
  - `reviewers`: Reviewers, one worker on `codex-sol` and one on `opus`, with
    cross-model review on.

  The templates ship with kawai under `config/groups/`. The action never
  overwrites a file, never commits, and is offered to the human only — no
  agent tool can run it.
- **New Session notice**: when the New Session dialog creates a chat for such
  a project, it shows that the project has no team groups, with a link to the
  team's Members tab where Set up team waits. The notice never blocks
  creating the chat. The written files are ordinary group files the human
  edits afterwards.
- **Cross-model review** (`crossModelReview: true` in a group file): a review
  handoff to that group routes only to members and spawn slots whose model
  family differs from the family of every profile that submitted a result on
  the task. The filter runs in the shared eligibility check, before routing
  rules, for every review handoff (agent, human, or plan execution). A review
  with no eligible worker waits with a new `cross-model` waiting reason; a
  handoff whose worker choice names only the authors' family is refused.
- **Model families in the catalog**: providers and models may name a
  `family` (for example `claude`, `gpt`, `glm`) at the trusted tier only — the
  shipped and user-level catalogs. A model without one is its own family (its
  profile id). The shipped catalogs name the family of every shipped model,
  so `openrouter-opus` and `opus` are both `claude`.
- **Result authorship snapshot**: a submitted result records the submitting
  session's profile id, so the authors' families stay known after the
  implementer is released or archived.
- The Members tab's "no control edits a group" rule gains one exception: the
  setup action, which only creates files that do not exist.

## Capabilities

### New Capabilities
- `team-setup`: the Team page action that seeds a team's starter role groups
  from shipped templates — when it is offered, what it previews, what it
  writes, and what it never does.

### Modified Capabilities
- `team-workspace`: the Members tab may offer the setup action; it still
  edits no existing group file.
- `team-routing-rules`: groups may require cross-model review; the shared
  eligibility check excludes candidates of the authors' families.
- `team-waiting-reasons`: a review held for a cross-model worker names that
  reason and the authors' families.
- `claude-session-profiles`: catalog providers and models may name a model
  family, at the trusted tier only.
- `task-results`: a result records its author's profile id.

## Impact

- Server: a new team-setup module and a WS mutation beside
  `team-workspace-approval-default-set` (`workspaceConnections.ts`), which
  publishes the workspace after writing; `groupFile.ts` (new flag);
  `profileCatalog.ts` / `catalogParse.ts` (new `family` field);
  `routing/workerEligibility.ts`, `router.ts`, `groupDispatchPreview.ts`,
  `candidates.ts` (family filter); `waitingReasons.ts` and
  `src/shared/team.ts` (new kind); `taskResultSchema.ts` and
  `TaskResultService.ts` (profile snapshot column, handoff refusal).
- Client: `TeamMembersPanel.tsx` (empty-state action and preview dialog),
  `NewSessionModal.tsx` and `chat/useTeamGroups.ts` (missing-groups notice
  and link), `waitingLabels.ts`. `GET /api/team-groups` gains the team key
  and whether setup is available.
- Shipped data: `config/groups/{lead,devs,reviewers}.md`; `family` on every
  entry of `config/providers.default.json` and `config/profiles.default.json`.
- Docs: `docs/architecture/team-page.md` (Members bullet), `routing.md`,
  `tasks.md`, `mailbox.md`; `docs/claude-session-profiles.md`;
  `docs/routing/README.md` (the tags remain, the built-in filter is new).
- Database: one nullable column on `team_task_results`; old rows fall back to
  the session record.
- Overlap: `team-workspace-redesign` (not started) renames Members to Agents
  and modifies the same read-only requirement; whichever archives second
  rebases its delta onto the other.
- No new dependency; nothing leaves the machine.
