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
  (`useSessionRow`: a chat or a tmux terminal, live or archived),
  `selectedHibernatingSession` (`App.tsx:295`, from the filtered hibernating
  list or the pending one), `teamLocation` (`useTeamPageRoute`), the
  workspace snapshot (`useWorkspaceStore`), and `serverInfo`. The two
  selections are exclusive: setting one clears the other
  (`sessionStore.ts:237-246`). `Session.remote` marks a session from another
  host, and `workspaceView.ts` never places remote sessions in local
  worktrees. Hibernating `AgentSession`s come from this server's own logs
  (`host: config.hostLabel`, `src/server/agentSessions.ts:16`), so they are
  always local.
- Filters change the selection. When a filter hides the selected live chat,
  or the selected hibernating session, `App.tsx:502-526` and `:528-566`
  select the first visible target or clear the selection, except while a
  Team route is shown, where the correction waits until the user returns.
- The server names a repository after its main checkout's basename
  (`src/server/git/workspaceSnapshot.ts:119`). The client reads `name` as
  given and never re-derives it.
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
     null. `session` is `{ projectPath, remote }` or null. With a team key it
     names the team's repository
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
   `useMemo` from `teamLocation?.teamKey`, the displayed session, the
   snapshot's repositories, and the last successful `serverInfo`. The
   displayed session is `selectedSession` (chat or terminal, live or
   archived, passed as `{ projectPath, remote: remote === true }`), else
   `selectedHibernatingSession` (passed as `{ projectPath, remote: false }`),
   else null. That is the same session the pane renders. The title effect
   depends on `labels.title`, and `Header` gets a new `contextLabel` prop
   (`labels.heading`). Both read one value, so the heading and the title
   cannot disagree. *Alternative:* a hook inside `Header`. Rejected:
   `Header` does not mount under the redesigned `TeamShell`
   (team-workspace-redesign), and the title must keep working there.
   *Alternative:* label only chats. Rejected: a terminal or hibernating
   session would then show the instance name while its own project fills the
   pane.

6. **Filters reach the labels only through the selection.** Filters and the
   browser default are not inputs to `labels`. A filter that hides the
   selected session works through the existing fallback (Context), which
   changes the displayed session, and the labels follow it. While a Team
   route is shown, the fallback waits, so the title keeps the team name.
   This change does not touch the fallback.

7. **The heading belongs to the navigator.** The heading is shown wherever
   `Header` mounts. Today that includes Team routes, so it shows the team's
   repository there. Under `team-workspace-redesign`'s `TeamShell`, `Header`
   is not mounted, and the browser title alone carries the Team context.
   Table L states both shells for the Team rows.

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
`/projects/manga` (main). Its display name deliberately differs from the
checkout's basename, so a row expecting it fails any implementation that
returns the basename instead of the repository. Today's server would name it
`manga`, but the client contract is to show `name` as given.

Table C — `contextName` (in `src/client/__tests__/contextName.test.ts`):

| Oracle | teamKey | session path | remote | repositories | Expected |
| --- | --- | --- | --- | --- | --- |
| C1 | `/home/coder/kawai` | * | * | as above | `kawai` |
| C1b | `/projects/manga` | * | * | as above | `Manga Studio 日本` (not the basename `manga`) |
| C2 | `/projects/plain` | * | * | as above | `plain` |
| C3 | `/projects/manga` | `/home/coder/kawai` | false | as above | `Manga Studio 日本` |
| C4 | none | `/home/coder/kawai/.worktrees/adopt/src` | false | as above | `kawai` |
| C5 | none | `/home/coder/kawai` | false | as above | `kawai` |
| C6 | none | `/home/coder/kawai-notes` | false | as above | `kawai-notes` |
| C7 | none | `/home/coder/kawai/.worktrees/adopt` | true | as above | `adopt` (the local lookup would give `kawai`) |
| C7b | none | `/projects/manga` | true | as above | `manga` (the local lookup would give `Manga Studio 日本`) |
| C8 | none | `/home/coder/kawai/.worktrees/adopt` | false | null | `adopt` |
| C9 | none | `/p/outer/vendor/inner/x` | false | as above | `inner` |
| C10 | none | `/p/outer/src` | false | as above | `outer` |
| C11 | none | `/projects/Anime Studio 日本/` | false | as above | `Anime Studio 日本` |
| C12 | none | `/projects/manga/x` | false | as above | `Manga Studio 日本` |
| C13 | none | `/` | false | as above | null |
| C14 | none | none | * | as above | null |

Unreachable combination: a team key together with a remote session needs no
row, because the team key always wins (C3). Session kind (chat, terminal,
archived, hibernating) is not an input to `contextName`. App maps each kind
to `{ projectPath, remote }` (Decision 3), and table L covers each mapping.

Table B — `brandLabels` (same file):

| Oracle | contextName | workspaceName | heading | title |
| --- | --- | --- | --- | --- |
| B1 | `kawai` | `anime-studio` | `kawai` | `kawai - Kawai` |
| B2 | null | `anime-studio` | `anime-studio` | `anime-studio - Kawai` |
| B3 | null | null | `KAWAI` | `Kawai` |
| B4 | `kawai` | null | `kawai` | `kawai - Kawai` |

Table L — the production App (`src/client/__tests__/app.test.tsx`, replacing
"App workspace title"). The server reports `/projects/anime-studio` unless a
row says otherwise, and the snapshot holds the repositories above unless a row
says it has not arrived. Each row asserts both `document.title` and the
heading. "Kawai chat" means a live local chat in
`/home/coder/kawai/.worktrees/adopt`, and "manga chat" a live local chat in
`/projects/manga`. In the Team rows (L3b, L3b2, L3d4), the Heading cell names
the heading for today's shell, and after `TeamShell` (team-workspace-redesign)
the same row asserts that no navigator heading is rendered.

| Oracle | Prior state | Event | Title | Heading |
| --- | --- | --- | --- | --- |
| L1 | nothing selected | initial server-info pending, network failure, or HTTP failure | `Kawai` | `KAWAI` |
| L2 | nothing selected | initial server-info succeeds | `anime-studio - Kawai` | `anime-studio` |
| L3a | L2 | select the kawai chat | `kawai - Kawai` | `kawai` |
| L3j | L3a | select the manga chat | `Manga Studio 日本 - Kawai` | `Manga Studio 日本` |
| L3i | L2 | select an archived chat in `/home/coder/kawai/.worktrees/adopt` | `kawai - Kawai` | `kawai` |
| L3k | L2 | select a terminal session in `/projects/manga/x` | `Manga Studio 日本 - Kawai` | `Manga Studio 日本` |
| L3l | L2 | select a hibernating session in `/home/coder/kawai/.worktrees/adopt` | `kawai - Kawai` | `kawai` |
| L3m | L2 | select a remote chat in `/home/coder/kawai/.worktrees/adopt` | `adopt - Kawai` | `adopt` |
| L3b | L3a | open the Team route `/projects/manga` | `Manga Studio 日本 - Kawai` | `Manga Studio 日本` (TeamShell: absent) |
| L3b2 | L3a | open the Team route `/projects/another-project` | `another-project - Kawai` | `another-project` (TeamShell: absent) |
| L3c | L3b | leave the Team route | `kawai - Kawai` | `kawai` (shown again under both shells) |
| L3d | L3a | change project and host filters so the kawai chat stays visible | `kawai - Kawai` | `kawai` |
| L3d2 | L3a | change filters so only the manga chat is visible (the fallback selects it) | `Manga Studio 日本 - Kawai` | `Manga Studio 日本` |
| L3d3 | L3d2 | change filters so no session is visible (the fallback clears the selection) | `anime-studio - Kawai` | `anime-studio` |
| L3d4 | L3b | change filters so the kawai chat is hidden | `Manga Studio 日本 - Kawai` | `Manga Studio 日本` (TeamShell: absent) |
| L3e | L3a | change the browser default project setting | `kawai - Kawai` | `kawai` |
| L3f | L3a | clear the selection | `anime-studio - Kawai` | `anime-studio` |
| L3g | L2, no snapshot | select the kawai chat, then the snapshot arrives | `adopt - Kawai`, then `kawai - Kawai` | `adopt`, then `kawai` |
| L3h | initial server-info pending | select the kawai chat | `kawai - Kawai` | `kawai` |
| L4 | L2 | reconnect server-info succeeds with `/projects/manga-studio` | `manga-studio - Kawai` | `manga-studio` |
| L5 | L2 | reconnect server-info fails (network or HTTP) | `anime-studio - Kawai` | `anime-studio` |
| L6 | L2 | reconnect server-info succeeds with `/` and `///` | `Kawai` | `KAWAI` |

Each L1 and L5 alternative is its own case. Each row's prior state is reached
through the same App, not seeded into it. T1–T7 in `pageTitle.test.ts`
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
  change lands second re-runs table L, with the Team rows asserting the
  heading absent under `TeamShell` (Decision 7).
- [A filter can retitle the tab] → This is intended, because the filter
  changed what the pane shows (Decision 6, L3d2–L3d3). The title never reads
  the filter itself (I3).
- [Removing an `instance-identity` requirement orphans existing `@covers`
  annotations] → Task 2.2 rewrites them to the new scenario names in the same
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
  in order, for each alternative. Under `TeamShell`, the Team rows show the
  Title with no navigator heading, and L3c shows it again.
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
  inputs to the context name or the labels. They reach the labels only by
  changing the displayed session through the existing fallback.
- I4: A remote session's name never comes from the local snapshot.
- I5: The labels name the session the pane renders: the selected chat or
  terminal, else the selected hibernating session, else none.

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
- X5: No change to the filtered-selection fallback.
