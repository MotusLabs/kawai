# Design

## Context

See proposal.md for motivation. `index.html` supplies the static title `Kawai`; no client code currently writes `document.title`. `src/client/App.tsx` already fetches `/api/server-info` on mount and connection-epoch changes and stores successful responses. The endpoint supplies `defaultProjectDir` and `cwd`. Browser-local settings separately control new-session defaults. Existing app tests in `src/client/__tests__/app.test.tsx` mount the production App with mocked browser globals and transport.

## Goals / Non-Goals

**Goals:** Reuse server metadata to give every page in one instance a stable workspace title, with a deterministic fallback.

**Non-Goals:** Custom instance labels, session-specific titles, Git discovery changes, PWA manifest names, and server-rendered HTML titles.

## Decisions

1. Use the final non-empty `/`-separated component of `defaultProjectDir`, then `cwd`, then no name. Treat absent, empty, and separator-only paths as nameless. Preserve the component literally, including whitespace inside names and Unicode. Server paths are already resolved POSIX paths. A trailing slash does not erase the name. This interprets “workspace” as the server's project directory; the selected session and browser defaults would make instance identity vary by tab and are therefore unsuitable.
2. Add a small pure formatter in `src/client/utils/pageTitle.ts` and a title effect in App driven by server information. Reuse the current fetch and reconnect lifecycle; do not add a request or a wire field. Successful responses replace the derived title; failed refreshes retain existing information and therefore the last title. The static HTML title remains `Kawai` for initial loading. Use `document.title` so names remain text.
3. Keep the formatter independent of React, and cover document wiring through the production App tests. A formatter-only test could miss a disconnected effect (oracle-hazards M1). There is no durable state or transactional recovery to model.

### Acceptance oracles

Commit these concrete input/output tables verbatim as table-driven tests alongside implementation. `*` means the value is irrelevant. All paths are server-reported strings; absent fields are represented by null or undefined cases.

| Oracle | defaultProjectDir | cwd | Expected title |
| --- | --- | --- | --- |
| T1 | `/projects/anime-studio` | `/opt/kawai` | `anime-studio - Kawai` |
| T2 | absent | `/projects/anime-studio` | `anime-studio - Kawai` |
| T3 | empty string | `/projects/anime-studio/` | `anime-studio - Kawai` |
| T4 | `/` | `/projects/anime-studio` | `anime-studio - Kawai` |
| T5 | `/projects/Anime Studio 日本///` | * | `Anime Studio 日本 - Kawai` |
| T6 | absent | absent | `Kawai` |
| T7 | `/` | `///` | `Kawai` |

| Oracle | Prior title | Observable event | Expected title |
| --- | --- | --- | --- |
| L1 | `Kawai` | Initial server-info request is pending or fails | `Kawai` |
| L2 | `Kawai` | Server-info succeeds with T1 fields | `anime-studio - Kawai` |
| L3 | `anime-studio - Kawai` | Session selection, Team route, filter, or browser default project setting changes | `anime-studio - Kawai` |
| L4 | `anime-studio - Kawai` | Reconnect server-info succeeds with defaultProjectDir `/projects/manga-studio` | `manga-studio - Kawai` |
| L5 | `anime-studio - Kawai` | Reconnect server-info request fails | `anime-studio - Kawai` |
| L6 | `anime-studio - Kawai` | Reconnect server-info succeeds with T7 fields | `Kawai` |

Each L1 alternative and each L3 event gets a separate table case. These are representative acceptance examples, not an exhaustive path grammar or a new recovery state machine. No generated property tests or new dependencies are needed for this small change.

## Risks / Trade-offs

- Identical directory basenames produce identical titles → accepted for this scope; custom labels can be a separate feature.
- The title is briefly generic while metadata loads → retain the existing static fallback and reuse the existing request.
- Existing app-test browser stubs may omit a title → initialize and restore the title in the existing isolated test setup.

## Migration Plan

Deploy the normal client build; no data migration or configuration changes. Rollback restores the static title by reverting the client change.
