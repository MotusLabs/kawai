# Tasks

Archive after per-result-suite is archived: this change MODIFIES the requirement "Pushes require a full check of the pushed tree", which per-result-suite ADDS.

## 1. Lookup and decisions

- [ ] 1.1 `scripts/lib/treeRecord.ts`: take an optional Bun version for the key and the field checks, defaulting to the running Bun. Verify: a record under the pin's key is found only with the pin; mismatched bun, platform, arch, or treeId, and expired records, read as null; the default lookup is unchanged.
- [ ] 1.2 `scripts/lib/pushCheck.ts`: `parseBunPin`, and the facts `bun`, `pin`, `recordedBun`. Refuse a pin mismatch with no pass before the fallback, and name the pin in the not-checked-out and dirty commands. Verify with a decision table over the D3 rows, plus a preserved-behavior table for an absent or equal pin.
- [ ] 1.3 `scripts/pre-push.ts`: read the pin from `<commit>:.bun-version`, look up the running Bun, then the pin. Verify with a real push to a bare remote: a pass seeded under the pin pushes with no check, and no pass is refused with the pin named and no check run.
- [ ] 1.4 Verify every missing-pass refusal line classifies as permanent under `classifyEffectFailure`.

## 2. Docs

- [ ] 2.1 Update AGENTS.md's pre-push paragraph and the header comments of `.githooks/pre-push`, `scripts/pre-push.ts`, `scripts/lib/pushCheck.ts`, and `scripts/lib/treeRecord.ts`.
