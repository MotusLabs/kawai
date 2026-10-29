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
- The memo hands out the catalog object it holds. Its projections are
  `ReadonlyMap`s, but `entry.catalog` hands out mutable maps, so the guard is
  behavioral: Table W's row W5 pins that no production consumer changes the
  catalog it reads.
- Routed read sites: `providerOf`, `providerLabelOf`,
  `providerDefinitionOf`, `runtimeFactsOf` (the start guard), and the usage
  pull's balance-key read. The launch resolution
  (`launchFor` → `resolveClaudeProfile`) and the other direct resolvers stay
  direct: they run once per spawn or command, not per sweep. The usage
  cadence builds a launch environment on every tick, so each tick still
  resolves the catalog once directly — a documented scope limit, not a
  cached path (row W4).

### D3 — Memoized zone validity, a snapshot for repeated lookups

- `isResetTimeZone` caches its answer per zone string in a `Map`, bounded at
  256 entries. Fixed offsets are parsed without `Intl`, as today.
  `offsetMinutes` itself stays per call, because the offset depends on the
  instant, so DST reset times keep their meaning.
- After D1–D2, re-profile the scratch boot. The original plan was: if the
  key's stats still exceed 5% of busy samples, memoize `projectCatalogFiles`'
  realpath per raw path for one dispatch pass.
- Measured on 2026-10-29, with Claude and Codex stubs that pass the version
  check and then idle: after D1–D2 the key's stats were 7.40% of busy
  samples. `statSync` on each level file, not realpath, made up most of it,
  and 1,223 of the 1,374 catalog samples came from the mailbox's recipient
  sweep. Every session's cooldown looks up its provider, roughly 14 stats per
  lookup, and most sessions share a few contexts.
- So instead of a realpath memo, `withCatalogSnapshot(read)` holds the catalog
  still for one synchronous read. Inside it, each distinct raw context
  computes its key once and repeats reuse the entry; a nested call joins the
  open snapshot. The mailbox wraps its `recipients()` sweep in one. The
  snapshot ends with the read, so an edit still applies at the next lookup
  after it, and freshness outside a sweep is unchanged. A synchronous scope
  cannot leak across awaits, and the parameter type refuses a promise.

*Alternative:* a per-dispatch-pass key cache. Rejected: the pass awaits
between its steps, so a cache living across it would delay edits by a whole
pass and needs explicit invalidation; the sweep is where the repeats are.

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
| K9a/K9b | only the image providers / profiles path differs; both default files exist with different content | no | 2, each with its own content |
| K11a/K11b | only the image providers / profiles path differs; both default files are missing | no | 2, equal catalogs (precision only) |
| K11c/K11d | only the image providers / profiles path differs; user-level files replace the defaults, which are never read | no | 2, equal catalogs (precision only) |

While a default file exists, its level line already carries its path, so
removing the path part from the key is equivalent for K9. Only K11 observes
it (R15, R16). K10 is not used.

### Table E — eviction

| id | sequence | result |
|---|---|---|
| E1 | 65 distinct keys, then the first | the first resolves again (evicted) |
| E2 | 64 keys, touch the first, add one | the first stays; the second is evicted |

### Table N — synchronous snapshot (`withCatalogSnapshot`)

| id | sequence | result |
|---|---|---|
| N1 | 50 lookups of one context inside a snapshot | the key's stats run once (as many as one lookup outside) |
| N2 | lookups of two contexts reaching different files inside one snapshot | each sees its own catalog |
| N3 | a file edited inside a snapshot, then a lookup after it | unseen inside, seen at the first lookup after |
| N4 | a snapshot opened inside an open one | no new stats; the outer one ends the snapshot |
| N5a/N5b | contexts A, B, A differing only in the image providers / profiles path, defaults present with different content | B is its own entry with its own content; the second A is A's entry |
| N5c/N5d | the same, defaults missing | B is its own entry with an equal catalog |
| N5e/N5f | the same, user-level files replacing the defaults | B is its own entry with an equal catalog |

### Table W — production wiring

A read site is counted by the reads of the project's own catalog file, one
per resolution, after a fresh key. Each row also compares its value with an
independent fresh resolution.

| id | public call | result |
|---|---|---|
| W1 | the mailbox's recipient sweep (the closure it hands its dispatcher), twice | each catalog context's key is computed once per sweep, anchored to the level count |
| W2 | `providerDefinitionOf`, 4 calls | reads `[1, 0, 0, 0]`; the definition equals a fresh resolution's |
| W3 | `startBlockerFor` (`runtimeFactsOf`), 4 calls | reads `[1, 0, 0, 0]`; the runtime refusal names a fresh resolution's runtime |
| W4 | the usage cadence (`providerUsageTarget`), 4 ticks | reads exactly `[2, 1, 1, 1]`: the direct launch resolution on every tick, plus the provider lookup that warms the memo before the balance-key read on the first. Every credits pull carries the value under a fresh resolution's balance-key name |
| W5 | the sweep with a cooldown, `providerDefinitionOf` with `quotaReadingOf`, `startBlockerFor`, the usage cadence, `providerOf`, `providerLabelOf`, twice | the entry is the same object and deep-equals an alias-free baseline from its own resolution; the lazy projections equal the baseline's |

A balance-key bypass (R13) would read `[3, 2, 2, 2]` in W4. That is a
prediction: R13 is a structural twin of R11 and was not run.

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
  consumers' views] → Only the entry's projections are `ReadonlyMap`s;
  `entry.catalog` and the definitions it holds are mutable objects. Row W5
  runs every production consumer against one entry and checks it against an
  alias-free baseline, and P1 compares with a fresh resolution after each
  lookup sequence.
- [The usage cadence still resolves the launch catalog directly on every
  tick] → By design (D2): the launch resolution is outside the memo. W4 pins
  the exact total, so a new uncached read on that path fails it.

## Migration Plan

None. In-memory only. Roll back by reverting.
