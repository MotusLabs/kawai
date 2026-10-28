# Proposal

## Why

Profile-catalog resolution runs on every cooldown and routing check, so a
team's mailbox and dispatcher re-parse the catalog files over and over. On
2026-10-29, a boot against a copy of the live data spent 15–45 s of busy CPU
there. Most of it was `Intl.DateTimeFormat` construction while validating
`limitResetTimeZone`, plus re-reading and re-merging the JSON files.

The resolution is meant to be cached per catalog stamp, but it is not. Three
caches (`providerOf`, `providerLabelOf`, `providerDefinitionOf`) key on the
exact project path and clear completely once they hold 32 entries. With
589 sessions across dozens of worktree paths, they never hold, so nearly
every lookup resolves the whole catalog again.

## What Changes

- One shared resolution memo replaces the three caches. It is keyed by what
  resolution actually reads: the existing catalog files with their tier,
  trust, kind, and stamp, plus `HOME` and `CODEX_HOME`. All project paths that
  see the same files share one entry. A file edit changes the stamp, so it
  still takes effect at the next lookup, as today.
- Eviction is least-recently-used and bounded, never a full clear.
- Time-zone validity (`isResetTimeZone`) is memoized per zone string: a zone
  name's validity does not change while the server runs.
- No behavior changes. Catalog contents, errors, freshness after an edit,
  and every consumer's results stay the same.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is a performance change with no spec-level behavior change
(`skip_specs: true`).

## Impact

- `src/server/chat/catalogMemo.ts` (new): the resolution memo, `providerOf`,
  and `providerLabelOf`, re-exported from `profileCatalog.ts`, whose
  `profileCatalogStamp` stays for its other consumers.
- `src/server/chat/ChatSessionManager.ts`: `providerDefinitionOf` uses the
  shared memo.
- `src/server/chat/limitSignals.ts`: the memoized `isResetTimeZone`.
- `docs/architecture/`: the profile catalog bullet notes the memo.
