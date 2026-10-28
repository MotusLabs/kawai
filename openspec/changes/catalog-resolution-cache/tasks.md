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

- [ ] 2.1 Memoize `isResetTimeZone` per zone string, bounded at 256.
  - Verify: property P2 (every supported zone, plus 50 malformed strings,
    seed `0x7e2a`) passes. R5 is killed.
- [ ] 2.2 Re-profile the scratch boot against a copy of the live data.
  - Verify: catalog resolution and `Intl.DateTimeFormat` together stay
    under 5% of busy samples. Record the stat cost, and apply D3's realpath
    memo only if the stats exceed 5%.

## 3. Integration

- [ ] 3.1 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass.
- [ ] 3.2 Map every oracle id (K1–K8, E1–E2, P1, P2) to a test title and
  each mutant to its killing test.
  - Verify: the map has no gap.

## Workflow follow-up

- Independent of `bounded-boot-restore` and `bounded-history-capture`; it can
  land in any order.
- Push and open the PR when the human asks.
