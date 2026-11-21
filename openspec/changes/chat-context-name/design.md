# Design

## Context

See proposal.md for motivation and the specs for the required behavior
(`specs/workspace-navigation`, `specs/instance-identity`).

What exists today (master at fd0b835b):

- `src/client/components/Header.tsx:52-57` renders a fixed `<h1>KAWAI</h1>`
  with the tooltip `Kawai v<version>`.
- `src/client/utils/pageTitle.ts` formats `<workspace name> - Kawai` from
  `/api/server-info` (`defaultProjectDir`, then `cwd`). `src/client/App.tsx`
  writes it in an effect on `serverInfo` only (around `:935`).
- `src/client/utils/teamKey.ts` already finds the repository owning a path:
  `teamKeyOf` matches every worktree of the snapshot by whole path segments
  (`root === target || target.startsWith(root + '/')`), keeps the deepest
  match, and returns the repository's main checkout. A chat outside every
  repository keys by its own directory. Team routes carry that key
  (`TeamLocation.teamKey`), so a team key is a main checkout or a plain
  directory.
- `App.tsx` already holds every input: `selectedSession`
  (`useSessionRow`, which also returns archived rows), `teamLocation`
  (`useTeamPageRoute`), the workspace snapshot (`useWorkspaceStore`), and
  `serverInfo`. `Session.remote` marks a session from another host.
  `workspaceView.ts` never places remote sessions in local worktrees.
- Tests: `src/client/__tests__/pageTitle.test.ts` (T1–T7),
  `src/client/__tests__/app.test.tsx` "App workspace title" (L1–L6, with
  `@covers` on the instance-identity scenarios), and
  `src/client/__tests__/header.test.tsx`.

## Goals / Non-Goals

**Goals:** One derivation of the context name, read by both the heading and
the browser title. Repository lookup shared with the team key, so the title,
the heading, and the Team views agree on which repository owns a path.

**Non-Goals:** Server or wire changes. Custom instance labels. The PWA
manifest name. The chat header's directory label (it keeps showing the
worktree). Git discovery changes. Showing the branch or worktree in the
heading.

## Decisions

1. **Extract the repository lookup from `teamKeyOf`.** Add
   `owningRepository(path, repositories)` to `src/client/utils/teamKey.ts`,
   returning the repository of the deepest worktree that contains the path by
   whole segments, or null. `teamKeyOf` is rewritten on top of it with no
   change in behavior. *Alternative:* call `deepestPathMatch` from
   `src/shared/workspace.ts` in a new module. Rejected: that would make a
   second matcher next to `teamKeyOf` (trailing-slash trimming differs), and
   the two readers could drift (oracle-hazards, "Several readers disagreeing
   on derived state").

2. **A pure context-name module.** Add `src/client/utils/contextName.ts`:
   - `contextName({ teamKey, session, repositories })` returns a string or
     null. With a team key it names the team's repository
     (`owningRepository(teamKey)?.name`, else the key's final component).
     Otherwise, with a session that is not remote, it uses
     `owningRepository(projectPath)?.name`, else the final component. A remote
     session uses the final component. No team key and no session gives
     null. A path with no non-empty component (`/`, empty) also gives null.
   - `brandLabels(contextName, workspaceName)` returns
     `{ heading, title }`: the first usable name of the two, or `KAWAI` and
     `Kawai` when neither is usable.

   `pageTitle.ts` splits its directory rule into `workspaceName(info)`,
   keeping `pageTitle(info)` as `brandLabels(null, workspaceName(info)).title`
   so the T1–T7 table stands unchanged.

3. **App computes once and hands it out.** `App.tsx` computes `labels` with
   `useMemo` from `teamLocation?.teamKey`, `selectedSession`, the snapshot's
   repositories, and the last successful `serverInfo`. The title effect
   depends on `labels.title`, and `Header` gets a new `contextLabel` prop
   (`labels.heading`). Both read one value, so the heading and the title
   cannot disagree. Filters and browser defaults are not inputs, so they
   cannot affect either. *Alternative:* a hook inside `Header`. Rejected:
   `Header` does not mount under the redesigned `TeamShell`
   (team-workspace-redesign), and the title must keep working there.

4. **The heading truncates.** The `h1` gets `min-w-0 truncate`, and its
   container gets `min-w-0`, so a long name ellipsizes and the navigator width
   holds. `text-balance` goes, since it has no effect on one line. The tooltip
   stays `Kawai v<version>`. The full name stays in the DOM text, so
   assistive technology reads it whole.

5. **Snapshot timing.** Before the first snapshot, `repositories` is null, so
   a worktree chat shows its directory name and switches to the repository
   name when the snapshot arrives. That is the same lag `teamKeyOf` has
   today. Waiting for the snapshot would leave the heading empty or stale
   instead.

### Acceptance oracles

Commit these tables verbatim as table-driven tests next to the code they
cover. `*` means don't care. In all of them, repository `kawai` has worktrees
`/home/coder/kawai` (main) and `/home/coder/kawai/.worktrees/adopt`.
Repository `outer` has `/p/outer`. Repository `inner` has
`/p/outer/vendor/inner`. Repository `Manga Studio 日本` has
`/projects/manga`.

Table C — `contextName` (in `src/client/__tests__/contextName.test.ts`):

| Oracle | teamKey | session path | remote | repositories | Expected |
| --- | --- | --- | --- | --- | --- |
| C1 | `/home/coder/kawai` | * | * | as above | `kawai` |
| C2 | `/projects/plain` | * | * | as above | `plain` |
| C3 | `/home/coder/kawai` | `/projects/manga` | false | as above | `kawai` |
| C4 | none | `/home/coder/kawai/.worktrees/adopt/src` | false | as above | `kawai` |
| C5 | none | `/home/coder/kawai` | false | as above | `kawai` |
| C6 | none | `/home/coder/kawai-notes` | false | as above | `kawai-notes` |
| C7 | none | `/home/coder/kawai` | true | as above | `kawai` (final component, not the lookup) |
| C7b | none | `/srv/manga-studio` | true | as above | `manga-studio` |
| C8 | none | `/home/coder/kawai/.worktrees/adopt` | false | null | `adopt` |
| C9 | none | `/p/outer/vendor/inner/x` | false | as above | `inner` |
| C10 | none | `/p/outer/src` | false | as above | `outer` |
| C11 | none | `/projects/Anime Studio 日本/` | false | as above | `Anime Studio 日本` |
| C12 | none | `/projects/manga/x` | false | as above | `Manga Studio 日本` |
| C13 | none | `/` | false | as above | null |
| C14 | none | none | * | as above | null |

C7 is the remote case where the lookup and the final component would give
the same name. C7b separates them: it uses a remote path that shares no name
with a local worktree, and a separate assertion checks that
`owningRepository` is never called for a remote session. Unreachable
combination: a team key together with a remote session needs no row, because
the team key always wins (C3).

Table B — `brandLabels` (same file):

| Oracle | contextName | workspaceName | heading | title |
| --- | --- | --- | --- | --- |
| B1 | `kawai` | `anime-studio` | `kawai` | `kawai - Kawai` |
| B2 | null | `anime-studio` | `anime-studio` | `anime-studio - Kawai` |
| B3 | null | null | `KAWAI` | `Kawai` |
| B4 | `kawai` | null | `kawai` | `kawai - Kawai` |

Table L — the production App (`src/client/__tests__/app.test.tsx`, replacing
"App workspace title"). The server reports `/projects/anime-studio` unless a
row says otherwise. Each row asserts both `document.title` and the heading
text.

| Oracle | Prior state | Event | Title | Heading |
| --- | --- | --- | --- | --- |
| L1 | nothing selected | initial server-info pending, network failure, or HTTP failure | `Kawai` | `KAWAI` |
| L2 | nothing selected | initial server-info succeeds | `anime-studio - Kawai` | `anime-studio` |
| L3a | L2 | select a chat in `/home/coder/kawai/.worktrees/adopt` with the snapshot loaded | `kawai - Kawai` | `kawai` |
| L3b | L3a | open the Team route `/projects/another-project` | `another-project - Kawai` | `another-project` |
| L3c | L3b | leave the Team route | `kawai - Kawai` | `kawai` |
| L3d | L3a | change project and host filters | `kawai - Kawai` | `kawai` |
| L3e | L3a | change the browser default project setting | `kawai - Kawai` | `kawai` |
| L3f | L3a | clear the selection | `anime-studio - Kawai` | `anime-studio` |
| L3g | L2, no snapshot | select the L3a chat, then the snapshot arrives | `adopt - Kawai`, then `kawai - Kawai` | `adopt`, then `kawai` |
| L3h | initial server-info pending | select the L3a chat | `kawai - Kawai` | `kawai` |
| L4 | L2 | reconnect server-info succeeds with `/projects/manga-studio` | `manga-studio - Kawai` | `manga-studio` |
| L5 | L2 | reconnect server-info fails (network or HTTP) | `anime-studio - Kawai` | `anime-studio` |
| L6 | L2 | reconnect server-info succeeds with `/` and `///` | `Kawai` | `KAWAI` |

Each L1 and L5 alternative is its own case. T1–T7 in `pageTitle.test.ts`
stay verbatim. No property test is needed: the matcher's whole-segment rule
is pinned by C6, C9, and C10, and its trailing-slash rule by C11.

## Risks / Trade-offs

- [Tabs on one instance no longer share a title] → This is intended: the
  title names what the tab shows. With nothing selected the tab still names
  the instance.
- [A worktree chat flickers from directory name to repository name on first
  load] → This only happens before the first snapshot (L3g). `teamKeyOf` has
  the same lag today.
- [Two repositories with the same directory name show the same label] →
  Accepted, as the earlier change accepted it. The chat header's full-path
  tooltip disambiguates.
- [`team-workspace-redesign` splits `App.tsx` into shells] → The derivation is
  pure and App-level, so it moves with whichever shell owns the title. Its
  task 1.3 must keep the title effect mounted in both shells. Whichever
  change lands second re-runs table L.
- [Removing an `instance-identity` requirement orphans existing `@covers`
  annotations] → Task 3.1 rewrites them to the new scenario names in the same
  commits, and the coverage guard checks them.

## Migration Plan

Ship it in the normal client build: no data, settings, or server change.
Reverting the client commits restores the fixed heading and the instance
title.

## Implementation contract

### Acceptance

- A1: `contextName` returns exactly the Expected column for every row of
  table C, and `brandLabels` returns the heading and title of every row of
  table B.
- A2: The production App shows the Title and Heading of every row of table L,
  in order, for each alternative.
- A3: `teamKeyOf` returns the same key as before for every existing
  `teamKey.test.ts` case. The extraction changes no behavior.
- A4: A context name wider than the navigator truncates on one line without
  widening the navigator, and hovering the heading shows `Kawai v<version>`.
  This is checked in a real browser.
- A5: `pageTitle` still returns the T1–T7 outputs.

### Invariants

- I1: The heading and the browser title derive from one computed value per
  render, so the heading name always equals the title's name part (or `KAWAI`
  with title `Kawai`).
- I2: Repository ownership of a path is decided by one function
  (`owningRepository`), used by both `teamKeyOf` and `contextName`.
- I3: Filters, host filters, and the browser default project setting are not
  inputs to the context name or the labels.
- I4: A remote session's name never comes from the local snapshot.

### Scope

- `src/client/utils/contextName.ts`
- `src/client/utils/teamKey.ts`
- `src/client/utils/pageTitle.ts`
- `src/client/App.tsx`
- `src/client/components/Header.tsx`
- `src/client/__tests__/contextName.test.ts`
- `src/client/__tests__/pageTitle.test.ts`
- `src/client/__tests__/app.test.tsx`
- `src/client/__tests__/header.test.tsx`
- `src/client/__tests__/teamKey.test.ts`
- `tests/e2e/**`

### Verification

- V1: `bun run test src/client/__tests__/contextName.test.ts` passes
  with tables C and B verbatim. Each mutant named in tasks 1.1–1.2 fails at
  least one row.
- V2: `bun run test src/client/__tests__/app.test.tsx src/client/__tests__/header.test.tsx src/client/__tests__/pageTitle.test.ts src/client/__tests__/teamKey.test.ts`
  passes with table L verbatim. The mutants in tasks 2.1–2.2 fail.
- V3: A Playwright check after `bun run build` covers A4.
- V4: `bun run check` passes on the clean committed tree, and the result maps
  every oracle id to a test title and the mutant it kills.

### Excluded

- X1: No server, wire, `/api/server-info`, or settings change.
- X2: No change to the chat header's project label or to the PWA manifest.
- X3: No branch or worktree name in the heading.
- X4: No restructuring of `App.tsx` beyond the labels computation and props.
  The shell split belongs to `team-workspace-redesign`.
