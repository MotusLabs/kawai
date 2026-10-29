# Tasks

Mutants (one-line edits; at most five per round). R3 first named "the input
key omits tier". That mutant is equivalent: a level's tier, kind, and trust all
follow from its file path (`2 + depth` for project files, which never coincide
with the base files), so it survives every oracle. It was replaced by the
CODEX_HOME omission, which changes Codex provider ids.

| id | file | mutation |
|---|---|---|
| R1 | `catalogMemo.ts` | missing files stay in the input key |
| R2 | `catalogMemo.ts` | the input key omits the stamp (mtime/size) |
| R3 | `catalogMemo.ts` | the input key omits CODEX_HOME |
| R4 | `catalogMemo.ts` | a hit does not refresh LRU recency |
| R5 | `limitSignals.ts` | the zone memo caches `true` for every input |
| R6 | `catalogMemo.ts` | the snapshot is not cleared when its read ends |
| R7 | `catalogMemo.ts` | the snapshot's raw context omits the project path |
| R8 | `catalogMemo.ts` | lookups ignore the open snapshot |
| R9 | `catalogMemo.ts` | a nested snapshot replaces the open one |

## 1. Shared resolution memo (D1, D2)

- [x] 1.1 Add `catalogInputKey` and `resolvedCatalog` with the LRU memo, and
  route `providerOf`, `providerLabelOf`, and `providerDefinitionOf` through
  it, removing the three path-keyed caches.
  - Verify: Tables K and E pass as table-driven tests titled by oracle id,
    counting resolutions through a seam on `resolveProfileCatalog`. R1, R2,
    R3, and R4 are each killed.
- [x] 1.2 Add property P1 (seed `0xca7a`, 40 sequences of 30 steps).
  - Verify: it passes, and the existing profile-catalog, routing, and
    cooldown suites pass unchanged. R2 is killed.
- [x] 1.3 Note the memo in the profile catalog bullet of
  `docs/architecture/`.
  - Verify: the bullet names the input key and states that edits apply at
    the next lookup.

## 2. Zone validity (D3)

- [x] 2.1 Memoize `isResetTimeZone` per zone string, bounded at 256.
  - Verify: property P2 (every supported zone, plus 50 malformed strings,
    seed `0x7e2a`) passes. R5 is killed.
- [x] 2.2 Re-profile the scratch boot against a copy of the live data.
  - Verify: catalog resolution and `Intl.DateTimeFormat` together stay
    under 5% of busy samples. Record the stat cost, and apply D3's realpath
    memo only if the stats exceed 5%.
  - Result (2026-10-29, Claude and Codex stubs, 55 s of busy samples, on top
    of bounded-boot-restore):
    - before: catalog 36.61%, `DateTimeFormat` 13.41%, key stats 7.55%;
    - after D1–D2: catalog 7.46%, `DateTimeFormat` 0.02%, stats 7.40%. That
      is still over 5%, and realpath was a small part of it (see D3);
    - after D3's snapshot: catalog 3.40% (1.87 s), `DateTimeFormat` 0.02%,
      stats 3.37%.
- [x] 2.3 Add `withCatalogSnapshot`, wrap the mailbox's recipient sweep in
  it, and route `runtimeFactsOf` and the balance-key read through the shared
  memo.
  - Verify: Table N passes, one test per oracle id. R6, R7, R8, and R9 are
    each killed.

## 3. Integration

- [ ] 3.1 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass.
- [ ] 3.2 Map every oracle id (K1–K8, E1–E2, N1–N4, P1, P2) to a test title and
  each mutant to its killing test.
  - Verify: the map has no gap.

## Workflow follow-up

- Independent of `bounded-boot-restore` and `bounded-history-capture`; it can
  land in any order.
- Push and open the PR when the human asks.
