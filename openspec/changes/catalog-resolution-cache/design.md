# Design

## Context

See proposal.md, Why.

`resolveProfileCatalog(ctx)` reads only the levels that
`profileCatalogLevels(ctx)` lists:
- the user-level pair, or the shipped defaults when neither user file exists;
- then, for a project path, the `providers.json`/`profiles.json` pair of
  every `.kawai` directory from the filesystem root down to the path's
  realpath. A pair's tier comes from its directory's depth (`2 + depth`), and
  files the user level already read are skipped.

Beyond the files, it reads `HOME` and `CODEX_HOME`; the latter resolves Codex
homes. Each consumer builds its cache key from the raw project path plus
`profileCatalogStamp(ctx)`, which is the mtime and size of every level,
missing files included. A missing file contributes nothing to the result but
still makes the key unique to its path.

## Goals / Non-Goals

**Goals:**

- At most one resolution per distinct set of catalog inputs, whatever the
  number of sessions and paths.
- Unchanged results and freshness. A catalog edit is seen at the next lookup,
  as the stamp key guarantees today.

**Non-Goals:**

- Removing the per-lookup stats that freshness needs. They are a small cost
  next to resolution. D3 measures them, and they are only reduced if they
  still dominate.
- Watching catalog files. The stamp check stays the mechanism.

## Decisions

### D1 — An input key instead of a path key

`catalogInputKey(ctx)` is `HOME`, `CODEX_HOME`, the image default paths in
use, and, for each level whose file exists, its
`file \0 kind \0 trusted \0 tier \0 mtimeMs \0 size`.

- Missing files drop out of the key. Their effect is fully captured by the
  tiers of the files that do exist, which stay in the key.
- Two project paths under the same `.kawai` directories therefore share one
  key.
- A file that disappears or appears changes the list, and so the key.

`profileCatalogStamp` stays exported unchanged, because other consumers
(group catalog, outbound destinations) key their own caches on it.

*Alternative:* keep the path key and raise the limit. Rejected: the limit
would have to scale with the number of worktrees, and every path would still
re-resolve once per edit.

### D2 — One shared, LRU-bounded memo

`resolvedCatalog(ctx)` returns the memoized `ProfileCatalog` for
`catalogInputKey(ctx)`. `providerOf`, `providerLabelOf`, and
`ChatSessionManager.providerDefinitionOf` all project from it.

- Each entry also memoizes its projection maps: profile → provider, provider
  → label, and the merged definitions.
- Eviction is LRU at 64 entries. A hit refreshes recency, so the hot set
  never thrashes.
- The memo hands out the catalog object it holds. Consumers already treat
  the result as read-only; a test pins that no consumer mutates it.

### D3 — Memoized zone validity, measured stat cost

- `isResetTimeZone` caches its answer per zone string in a `Map`, bounded at
  256 entries. Fixed offsets are parsed without `Intl`, as today.
  `offsetMinutes` itself stays per call, because the offset depends on the
  instant, so DST reset times keep their meaning.
- After D1–D2, re-profile the scratch boot.
  - If `profileCatalogStamp`/`profileCatalogLevels` stats still exceed 5% of
    busy samples, memoize `projectCatalogFiles`' realpath per raw path for
    one dispatch pass.
  - Otherwise leave them as they are, and record the measurement in the
    result.

## Acceptance oracles

### Table K — memo key (`catalogInputKey`)

| id | change between two lookups | same key? | resolutions |
|---|---|---|---|
| K1 | another project path under the same `.kawai` directories | yes | 1 |
| K2 | another project path that reaches an extra `.kawai` file | no | 2 |
| K3 | an existing catalog file edited (mtime or size) | no | 2 |
| K4 | a catalog file created where none existed | no | 2 |
| K5 | a catalog file deleted | no | 2 |
| K6 | the user-level file appears (shipped defaults replaced) | no | 2 |
| K7 | `HOME` or `CODEX_HOME` changes | no | 2 |
| K8 | the same path, same files, no edit | yes | 1 |

### Table E — eviction

| id | sequence | result |
|---|---|---|
| E1 | 65 distinct keys, then the first | the first resolves again (evicted) |
| E2 | 64 keys, touch the first, add one | the first stays; the second is evicted |

### Property P1 — results unchanged

For any generated catalog tree and any sequence of lookups and edits:
- `providerOf`, `providerLabelOf`, and the merged definition through the
  memo equal a fresh `resolveProfileCatalog(ctx)` projection for the same
  context;
- a file edit is seen at the next lookup.

Generator:
- 1–4 nested `.kawai` directories under a temporary root;
- providers and models drawn from 5 ids, with overlapping keys across tiers;
- lookups drawn from 6 project paths;
- edits that rewrite, add, or delete one file. Each edit is preceded by an
  mtime bump of at least 1 s, so the stamp changes regardless of filesystem
  resolution.

Seams: the real file system and a temporary `HOME`. Seed `0xca7a`,
40 sequences of 30 steps.

### Property P2 — zone validity unchanged

For every zone in `Intl.supportedValuesOf('timeZone')`, plus 50 seeded
malformed strings (seed `0x7e2a`), the memoized `isResetTimeZone` equals the
unmemoized check, on first and repeated calls.

## Risks / Trade-offs

- [A filesystem whose mtime and size both survive an edit] → Same exposure
  as today's stamp key. Not widened.
- [A consumer that mutates the shared catalog object would corrupt other
  consumers' views] → The P1 test compares against a fresh resolution after
  each lookup sequence, and the catalog's maps are passed out read-only
  (`ReadonlyMap` in the types).

## Migration Plan

None. In-memory only. Roll back by reverting.
