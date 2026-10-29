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

- [x] 3.1 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass. Done: pass record 576e34fc for the tree of 21192854.
- [x] 3.2 Map every oracle id (K1–K8, E1–E2, N1–N4, P1, P2) to a test title and
  each mutant to its killing test.
  - Verify: the map has no gap.

## 4. Review follow-up (findings `f4b1ebad`, conditions C1–C6)

Author controls (one-line edits to a disposable copy of the committed tree,
run by the author; not the formal reviewer's mutants, which the reviewer
chooses at the next review):

| id | file | control |
|---|---|---|
| R10 | `sessionMailbox.ts` | the recipient sweep runs without `withCatalogSnapshot` |
| R11 | `ChatSessionManager.ts` | `providerDefinitionOf` resolves directly, bypassing the memo |
| R14 | `ChatSessionManager.ts` | `providerDefinitionOf` clears the shared definitions map |
| R19 | `ChatSessionManager.ts` | `providerDefinitionOf` writes a nested field of the definition it returns |
| R16 | `catalogMemo.ts` | the input key omits the image profiles path |
| R18 | `catalogMemo.ts` | the snapshot's raw context omits the image profiles path |

Structural twins, covered by their own value and count tests but not run as
controls: R12 (`runtimeFactsOf` bypass) and R13 (balance-key bypass) twin
R11; R15 and R17 (the providers path) twin R16 and R18.

- [ ] 4.1 B1: row W1 — the real mailbox sweep, the closure the mailbox hands
  its dispatcher, computes each catalog context's key once per sweep, and a
  second sweep computes it again.
  - Verify: the count equals one lookup per context outside any snapshot,
    anchored to the level count. R10 fails it.
- [ ] 4.2 B3: rows W2–W4 — `providerDefinitionOf`, `startBlockerFor`
  (`runtimeFactsOf`), and the usage pull's balance key resolve through the
  memo.
  - Verify: after a fresh key, four public calls read the project's catalog
    file `[1, 0, 0, 0]` times, and each value equals an independent fresh
    resolution. R11 fails W2.
- [ ] 4.3 B2: row W5 — no production consumer changes the shared catalog.
  - Verify: after the sweep (cooldown and label), `providerDefinitionOf` with
    `quotaReadingOf` on the returned object, `startBlockerFor`, the usage
    pull, and `providerOf`/`providerLabelOf`, the entry is the same object
    and equals an alias-free deep baseline from its own resolution, and the
    lazy projections equal the baseline's. R14 and R19 fail it.
- [ ] 4.4 B4: rows K9, K11, and N5 vary each image-default path alone, in
  each regime: default present with different content, default missing
  (key precision; the fallback results are equal), and user-level files
  present (defaults unread; precision only).
  - Verify: R16 fails K11, R18 fails N5.
- [ ] 4.5 Add Table W and rows K9/K11/N5 to design.md, correct D2 and Risks,
  and add the B1 and B4 entries to `docs/oracle-hazards.md`.
- [ ] 4.6 Reopen 3.1 and extend the 3.2 map with the new rows and controls.

## Workflow follow-up

- Independent of `bounded-boot-restore` and `bounded-history-capture`; it can
  land in any order.
- Push and open the PR when the human asks.
