# Design

## Context

See proposal.md — Why. The current state this design builds on:

- **Groups** load from `~/.kawai/groups/` layered under
  `<groupsRoot>/.kawai/groups/` (`groupCatalog.ts`); `groupsRoot` is the main
  checkout for git teams and the directory itself for plain ones
  (`teamIdentity.ts`). Only `*.md` names count. Nothing watches the files:
  `SessionTeams.catalogForTeam` re-parses when `groupCatalogStamp` (listing,
  mtimes, sizes) changes, and role prompts are re-read at agent start.
- **No server path writes a project's `.kawai/`.** Project `.kawai` files are
  treated as agent-writable and untrusted (`profileCatalog.ts`). The Members
  tab is read-only by spec and by `docs/architecture/team-page.md`.
- **Team mutations go over WS by `teamPath`**: e.g.
  `team-workspace-approval-default-set` → `setApprovalDefault` →
  `…-result` → `publish(teamId)` (`workspaceConnections.ts`). The New Session
  picker reads `GET /api/team-groups?projectPath=` (`routes/teamGroups.ts`).
- **Routing** decides candidates with one pure check,
  `evaluateEligibility` (`routing/workerEligibility.ts`), whose
  `filterReasons` already applies `allowedProfiles`, `workerChoice`, and
  `excludedProfile` before any rule runs. Router, dispatch preview,
  `candidates.ts`/`teamCapacity.ts`, and waiting reasons call it.
- **Reviews** are handoffs: a `team_task_assignments` row with
  `handoff_kind='review'` and `result_id`, linked to its mail by
  `assignmentStore.byMessage`. Results store only `submitted_by_kind` and
  `submitted_by_session` (`taskResultSchema.ts`). Plan executions already add
  `author-profile:<id>` tags to their review mail (`executionRounds.ts`),
  read only by routing rules.
- **Profiles** carry `runtime` and `providerId`, but no lineage: `zai/glm`
  sets `model: "opus"` and `openrouter-opus` is Claude on a non-Claude
  provider, so neither provider nor model string tells the family.

## Goals / Non-Goals

**Goals:**
- One server operation writes the starter files; the Members tab and the
  New Session notice are its only entry points.
- Cross-model review is enforced in the shared eligibility check, so every
  reader (routing, preview, capacity, waiting reasons, handoff validation)
  gives the same answer.

**Non-Goals:**
- Editing, deleting, or re-seeding group files from the UI; a template
  gallery or choosing among several starter teams.
- Committing the files, or writing user-level groups.
- Cross-model filtering for anything but review handoffs (plain mail,
  task assignments to developers).
- Removing the `author-profile` tags or changing the route contract.
- Model-family filtering by vendor-account (that is `sharesLoginWith`).

## Decisions

### D1 — Templates are embedded text files under `config/groups/`

`config/groups/lead.md`, `devs.md`, `reviewers.md`, imported with
`with { type: 'text' }` beside the `config/*.default.json` imports, so the
compiled binary carries them and the written bytes equal the repository
files. *Alternative:* generating the files from a TypeScript object — rejected:
role prompts are prose the owner tunes, and a byte-equal file is easy to
review and test.

Starter frontmatter (bodies are generic role prompts using the team tools:
lead plans and creates tasks; devs work in their own worktree and submit
results; reviewers read only and submit findings):

| file | label | key settings |
|---|---|---|
| `lead.md` | Team Lead | `canCreateTasks: true`, `canCreatePlans: true`, `canReleaseMembers: true`, `worktreeScoped: false`, `workers: { codex-sol: 1 }`, `max: 1` |
| `devs.md` | Dev | `workers: { opus: 1, codex-sol: 1 }`, `max: 2` |
| `reviewers.md` | Reviewers | `workers: { codex-sol: 1, opus: 1 }`, `max: 2`, `crossModelReview: true`, `worktreeScoped: true`, `releaseOnTaskClose: true` |

### D2 — Offer condition: no `*.md` in the project groups directory

The action, the Members empty state, and the New Session notice all use one
function, `setupAvailable(groupsRoot)` → boolean, reading only `<groupsRoot>/.kawai/groups/`.
User-level groups do not count: the owner's `~/.kawai/groups/` holds reviewer
groups for every repository, and a rule over the resolved catalog would
never offer setup to them. *Alternative:* "no group with id `lead`" —
rejected: it would offer a partial write into a hand-made team.

### D3 — Write path: WS mutation, lstat guard, exclusive per-file link

Client sends `team-workspace-setup-run { teamPath }` after the preview (the preview
itself is client-rendered from `team-workspace-setup-preview { teamPath }` →
`team-workspace-setup-preview-result { groups, targetDir, warnings }`, where warnings
come from resolving each template's workers against the team's catalog).
The server:

1. resolves the team from `teamPath` (refuse an unknown team);
2. `lstat`s `<root>/.kawai` and `<root>/.kawai/groups`: a symlink refuses;
   a missing one is created with `mkdir` (no `recursive` through links);
3. re-checks D2 — any `*.md` refuses the whole setup (`already-set-up`,
   naming files);
4. for each template: writes a temp file `.<id>.md.<random>.tmp` in the
   groups directory, fsyncs, then `link()`s it to `<id>.md` (exclusive and
   atomic: `EEXIST` keeps the other file and records `skipped`), then unlinks
   the temp; any other error stops, unlinks the temp, and reports the files
   created so far;
5. replies `team-workspace-setup-result { ok, created, skipped, error? }` — the same
   envelope for refusals and success — and calls `publish(teamId)`.

Temp names never end in `.md`, so a concurrent catalog read never sees a
partial group. *Alternative:* `writeFile(…, { flag: 'wx' })` — rejected: it
can leave a truncated `<id>.md` on a write error.

No agent tool is added; the WS router whitelist gains the two types.
`GET /api/team-groups` adds `setupAvailable` for the New
Session notice (the client derives the team key with `teamKeyOf`), whose link calls the existing
`useTeamLocationStore.navigate({ teamKey, tab: 'members' })` and closes the
dialog.

### D4 — Model family: a trusted-tier catalog field with id fallback

`family` on providers, provider models, and `profiles.json` entries; model
over provider; absent → the profile id. It is a trusted-tier field like
`codexHome`: a project-level catalog that sets it is rejected. Otherwise an
agent could write `.kawai/profiles.json` declaring its own model a different
family and defeat the review rule. The fallback makes two unlabelled
profiles different families, which errs toward allowing a review; the
shipped catalogs label every model so the common aliases (`opus` /
`openrouter-opus`) match. `familyOf(profileId)` lives in the catalog memo
and is the only derivation.

### D5 — Authors: every result submitter of the task, snapshotted

New nullable column `team_task_results.submitted_by_profile`, set at
`task_submit_result` from the caller's `chat_sessions.claude_profile_id`.
`reviewAuthors(taskId)` returns, over all results of the task, the set of
`{ family }` for agent submitters plus `unknownAuthors` (agent submitters
whose profile is neither recorded nor recoverable from their session record).
Human submissions contribute nothing. All rounds count because a fix round
by another model still leaves the first author's code on the branch.
*Alternative:* only the reviewed result — rejected by that reason.

### D6 — Filter: a new eligibility input and `cross-model` kind

`EligibilityState` gains `crossModel: { excludedFamilies: string[];
unknownAuthors: string[]; familyOf: Record<string, string> } | null`. It is
non-null only when the target group has `crossModelReview` and the mail's
assignment is a review handoff. `filterReasons` adds `cross-model` after
`excluded-profile`. When `unknownAuthors` is non-empty, every candidate is
excluded. The mail-side state is built once per routing pass by
`crossModelState(message)` (assignment → result → `reviewAuthors`), which the
router consumes — the shipped derivation is `crossModelFilter`
(`routing/crossModel.ts`), feeding the shared eligibility check's `crossModel`
input that `candidates`/capacity forward from their callers; the waiting
reasons read the router's diagnosis. The task-dispatch preview and raw
staffing capacity never hold a review-handoff state — the preview accepts a
plain task assignment, capacity counts staffing — so they stay unfiltered
(integration correction: D6 as written named `groupDispatchPreview` as a
consumer; the shipped preview API has no review-handoff input).
`WaitingConstraintKind` gains `cross-model` (order: after
`worker-choice`), with detail naming the families, the unknown authors, and,
when other-family workers exist, their existing capacity constraints.

### D7 — Handoff refusal for a choice inside the authors' families

`TaskResultService.handoff` (all callers, including the system), when the
target group has the flag and the handoff names a worker choice, expands the
choice to its profiles and refuses with
`worker choice is within the authors' model family <f>` when none of them
has a family outside `excludedFamilies`. It writes nothing.

## Acceptance oracles

### Table S — setup decision (one row per outcome; `*` = don't care)

| id | caller | `.kawai` / `groups` | `*.md` present at confirm | per-file link | result |
|---|---|---|---|---|---|
| S1 | human WS | absent / absent | — | all ok | created lead, devs, reviewers; publish |
| S2 | human WS | dir / dir, only `README.txt` | no | all ok | created all three; `README.txt` untouched |
| S3 | human WS | dir / dir | yes (any, valid or not) | * | refused `already-set-up`, names files, nothing written |
| S4 | human WS | symlink / * | * | * | refused `symlink`, names `.kawai`, nothing written |
| S5 | human WS | dir / symlink | * | * | refused `symlink`, names `.kawai/groups` |
| S6 | human WS | dir / dir | no | `reviewers` EEXIST | created lead, devs; skipped reviewers; its bytes kept |
| S7 | human WS | dir / dir | no | devs write error | error; created [lead]; no `devs.md`, no temp left |
| S8 | human WS | unknown team | * | * | refused `unknown-team`, same envelope |
| S9 | agent | * | * | * | unreachable: no agent tool exists (asserted by tool list) |

Offer table O (one derivation, D2): O1 no dir → available; O2 dir with only
non-`.md` → available; O3 any `*.md` → not available; O4 user-level groups
only → available. The Members tab, the `team-groups` route, and the run
re-check each get a row over the same fixtures.

### Table E — review eligibility (candidate = one member or slot)

| id | group flag | mail | authors' families | unknown author | candidate family | worker choice | outcome |
|---|---|---|---|---|---|---|---|
| E1 | off | review | {claude} | no | claude | none | eligible |
| E2 | on | plain mail | * | * | claude | none | eligible |
| E3 | on | review | {claude} | no | claude | none | excluded `cross-model` |
| E4 | on | review | {claude} | no | gpt | none | eligible |
| E5 | on | review | {claude, gpt} | no | gpt | none | excluded `cross-model` |
| E6 | on | review | {} (human result) | no | claude | none | eligible |
| E7 | on | review | * | yes | * | none | excluded `cross-model` (unknown author) |
| E8 | on | review | {claude} | no | gpt | names only claude profiles | handoff refused, nothing written |
| E9 | on | review | {claude} | no | deepseek | provider with claude + deepseek | accepted; claude candidates excluded |
| E10 | on | review | {claude} | no | claude (task owner) | none | owner excluded; other eligible candidate preferred |
| E11 | on | review | {claude} | no | claude (rule pick) | none | pick unknown; built-in picks among eligible |

Family table F (D4): F1 model family set → it; F2 only provider family →
provider's; F3 neither → profile id; F4 project-level file sets `family` →
file rejected; F5 invalid identifier → file error; F6 shipped catalogs →
every model explicit (claude, gpt, glm, …).

### Properties

- **P1 (I1)**: for seeded random authors (1–4 results across 0–6 profiles,
  some human, some unrecoverable) and random group members/slots, no
  eligible candidate of a flagged review has a family in the authors'
  families, and any unknown author leaves zero eligible. Generator over the
  shipped catalog plus synthetic profiles; seam `evaluateEligibility`;
  seed `0x5eed01`; 400 cases (`propertyCases`).
- **P2 (I2)**: for seeded random pre-existing directory contents (0–5
  files, `.md` or not, random bytes, optional symlinks), running setup never
  changes or removes a pre-existing file's bytes and never creates a path
  outside `<root>/.kawai/groups/`. Seam: the setup module over a `/tmp`
  root; seed `0x5eed02`; 200 cases.
- **P3 (I3)**: for the same seeded states as P1, the router and the shared
  eligibility check (which `candidates` forwards) return the same eligible
  set and reasons over the same filtered states (one derivation, hazard
  "Several readers disagreeing"). Readers compare only over the same
  operation and available inputs: the task-dispatch preview (plain task
  dispatch) and raw staffing capacity never receive the filter and stay
  unfiltered. Seed `0x5eed03`; 200 cases.

Hazards consulted (`docs/oracle-hazards.md`): root swap (S4, S5, P2),
refusals missing the envelope (S3–S8 assert the success envelope), several
readers disagreeing (O, P3), M1 hand-built harness (V5 drives the real WS
handler and the real router composition).

## Risks / Trade-offs

- [The fallback family is the profile id, so an unlabelled alias of the
  author's model passes the filter] → shipped catalogs label every model;
  `docs/claude-session-profiles.md` tells user-catalog authors to set
  `family`.
- [An owner's user-level catalog replaces the shipped one and may omit
  `codex-sol` or `opus`] → the preview warns per missing worker; the group
  loader already warns and drops unknown workers.
- [Reviews wait forever when no other-family worker exists] → the
  `cross-model` reason says so on the Team page; the human can hand off
  elsewhere or edit the group.
- [Overlap with `team-workspace-redesign`, which renames Members to Agents
  and modifies the same requirement] → whichever change archives second
  rebases its MODIFIED block; the setup action moves with the tab.
- [Writing into a repository is new for kawai] → only the human's WS
  connection can trigger it, only into `<groupsRoot>/.kawai/groups/`, only
  creating, never through symlinks.

## Migration Plan

Additive. The `submitted_by_profile` column is added with the existing
`ALTER TABLE … ADD COLUMN` check pattern; old rows stay null and resolve
through the session record (D5). Rollback: older builds ignore the column and
the `crossModelReview` key (unknown group keys are ignored), so a written
`reviewers.md` loads there without the filter. The catalog parser rejects
unknown fields (`catalogParse.ts`), so an older build rejects a user-level
catalog file that sets `family`; the shipped catalogs travel with their
build. The rollback note in `docs/claude-session-profiles.md` says to remove
`family` from user-level files before downgrading.

## Implementation contract

### Acceptance
- A1: Set up team on the Members tab, after preview and confirm, writes `lead.md`, `devs.md`, `reviewers.md` into `<main-checkout>/.kawai/groups/` byte-equal to `config/groups/*`, commits nothing, and every open view of the team lists the three groups (Table S S1–S2).
- A2: Setup is offered exactly when the project groups directory holds no `*.md` (Table O), and refused writing nothing on any `*.md`, a symlinked `.kawai` or `groups`, or an unknown team, with the same reply envelope as success (S3–S5, S8).
- A3: A file that appears between the check and its creation is kept byte-for-byte and reported skipped; a write error leaves no partial group file and names the files created (S6, S7).
- A4: The New Session dialog, for a chat whose project has setup available, shows the missing-groups notice; its link closes the dialog and opens that team's Members tab; the notice never blocks creating the chat and is absent for terminal sessions and for projects with group files.
- A5: The shipped templates parse with no catalog error or warning against the shipped catalogs, with the workers, caps, and flags in D1.
- A6: A review handoff to a `crossModelReview: true` group routes only to candidates outside every result author's model family, before any routing rule, for agent, human, and plan-execution handoffs (Table E E1–E7, E10, E11).
- A7: A review handoff whose worker choice names only workers of the authors' families is refused, writing nothing; a choice keeping another family is accepted and filtered (E8, E9).
- A8: A held cross-model review carries the `cross-model` waiting reason naming the authors' families, unknown authors, and the other-family workers' capacity constraints, and clears when one frees up.
- A9: Catalog `family` resolves model over provider over profile id, is rejected below the user level, and every shipped model has an explicit family (Table F).
- A10: Each new result stores its submitter's profile id from the session record; older results resolve through the session record.

### Invariants
- I1: No candidate eligible for a flagged review shares a family with any of the task's result authors, and an unknown author leaves none eligible (P1).
- I2: Setup never modifies or removes an existing file and never writes outside `<groupsRoot>/.kawai/groups/` (P2).
- I3: Every reader that can hold a review-handoff state — routing, the shared eligibility check that `candidates` forwards, and the waiting reasons — derives cross-model eligibility through one function and agrees (P3). The task-dispatch preview (a plain task assignment) and raw staffing capacity never receive the filter and stay unfiltered.
- I4: No agent-reachable tool or route writes group files.
- I5: Model family is never taken from a project-level catalog.

### Scope
- `config/groups/**`
- `config/providers.default.json`
- `config/profiles.default.json`
- `src/server/team/**`
- `src/server/chat/profileCatalog.ts`
- `src/server/chat/catalogParse.ts`
- `src/server/chat/catalogMemo.ts`
- `src/server/routes/teamGroups.ts`
- `src/server/dbSafety/migrations.ts`
- `src/server/__tests__/**`
- `src/shared/team.ts`
- `src/shared/types.ts`
- `src/client/components/team/**`
- `src/client/components/NewSessionModal.tsx`
- `src/client/components/chat/useTeamGroups.ts`
- `src/client/utils/waitingLabels.ts`
- `src/client/protocol/**`
- `src/client/__tests__/**`
- `tests/e2e/**`
- `docs/architecture/*.md`
- `docs/claude-session-profiles.md`
- `docs/routing/README.md`

### Verification
- V1: Table S and Table O committed verbatim as table-driven tests in `src/server/__tests__/teamSetup.test.ts` over private `/tmp` roots, killing a mutant that drops the `lstat` symlink check and one that writes with `flag: 'w'`.
- V2: Table E committed verbatim in `src/server/__tests__/crossModelEligibility.test.ts`, killing a mutant that compares profile ids instead of families and one that omits earlier rounds' authors.
- V3: Table F committed verbatim in the catalog tests, killing a mutant that accepts `family` from a project-level file.
- V4: P1–P3 as seeded property tests with the seeds and case counts above, through `propertyCases`.
- V5: One production-composition test sends `team-workspace-setup-run` through the real workspace WS handler and asserts files plus a `team-workspace` push; one routes a real review handoff through `ProfileRouter` with a flagged group (kills a mutant that removes the `crossModelState` wiring from the router).
- V6: A client test for `NewSessionModal` covers the notice, link navigation to `{ tab: 'members' }`, and absence for terminal and set-up projects; a Playwright walkthrough covers Set up team from the notice to the listed groups.
- V7: `openspec validate starter-team-setup --strict` and `bun run check` pass.

### Excluded
- X1: No editing, deleting, or re-seeding of group files from the UI, and no choice among several starter teams.
- X2: No cross-model filter for non-review mail.
- X3: The `author-profile` tags and the route contract are unchanged.
- X4: Renaming Members to Agents belongs to `team-workspace-redesign`.
