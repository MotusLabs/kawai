# Proposal

## Why

The navigator heading always reads `KAWAI`, and the browser title always names
the server instance (`<server directory> - Kawai`). Neither says which project
the chat in front of the user belongs to. When one instance serves chats from
several repositories and many worktrees, the user has to read the chat
header's directory name (`adopt-tool-call-metrics`) and work out the
repository from it.

## What Changes

- The navigator heading (the `h1` in `src/client/components/Header.tsx`) shows
  the **context name** instead of the fixed `KAWAI`.
- The browser title becomes `<context name> - Kawai`.
- The context name comes from one derivation shared by both places:
  - In Team mode (a team route is shown): the team's repository.
  - Otherwise, for the selected chat: the name of the repository that owns
    the chat's working directory, taken from the workspace snapshot, so every
    worktree of `kawai` shows `kawai`.
  - A path no known repository owns (a remote session, a plain directory, or
    the snapshot not loaded yet): the path's final directory name.
  - Nothing selected: the server's workspace name, under today's rule
    (default project directory, then working directory).
  - No usable name at all: the heading shows `KAWAI` and the title shows
    `Kawai`, as today.
- The heading keeps its `Kawai v<version>` tooltip, and a long name truncates
  on one line.
- **BREAKING (behavior):** this reverses `instance-identity`'s rule that the
  title stays the same across session selection and Team pages, a non-goal
  of the archived `workspace-page-title` change (2026-10-26). With nothing
  selected the title is still the instance title. Filters and the browser's
  default-project setting still do not affect it, and the loading,
  refresh-failure, and reconnect rules stay as they are.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `instance-identity`: the browser title follows the current context (the
  Team route's repository, else the selected chat's repository or directory)
  and falls back to the server workspace name only when nothing is selected.
- `workspace-navigation`: adds a requirement that the navigator heading shows
  the same context name, with `KAWAI` as its fallback.

## Impact

- Client only. `src/client/App.tsx` (the title effect and the `Header` props),
  `src/client/components/Header.tsx`, `src/client/utils/pageTitle.ts`, and a
  new pure derivation module under `src/client/utils/`. Path matching reuses
  `deepestPathMatch` from `src/shared/workspace.ts`.
- Tests: `src/client/__tests__/pageTitle.test.ts`, the title cases in
  `src/client/__tests__/app.test.tsx` (the `L3 selection` and `L3 Team route`
  rows change), and the Header tests.
- No server, wire, API, settings, or dependency change. The data is already in
  the client: the selected session row, the team route, the workspace
  snapshot, and `/api/server-info`.
- Overlaps `team-workspace-redesign`: once that lands, `Header` is not mounted
  in Team mode, so the Team-mode rule only reaches the browser title there.
  Whichever change lands second keeps the title effect running under the new
  shells.
