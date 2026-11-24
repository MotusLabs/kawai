# Design

## Context

`per-result-suite` D4 made the pre-push hook the certificate. It looks up a full-pass record for each pushed commit's tree under the content key of `bun run check`. That key hashes the tree id, the Bun version, the platform, and the architecture (`checkKey.ts`). The lookup (`scripts/lib/treeRecord.ts`) always uses the running Bun. So a tree certified under its own pinned Bun is unknown to a hook that runs under another Bun. That hook then either refuses (when the commit is not checked out, or the tree is dirty) or runs the full check (on a clean HEAD). Inside Kawai's push effect, that check outlives the 120 s remote timeout.

## Goals / Non-Goals

**Goals**

- Accept a pass recorded under the pushed tree's own pin.
- Refuse fast, with an actionable message, when the hook's Bun cannot produce a usable pass for that tree.
- Keep every other verdict as it was.

**Non-Goals**

- Choosing or running a different `bun` binary (no toolchain lookup).
- Changing Kawai's push effect, its timeout, or its classifier.
- Changing the pre-commit hook, `scripts/check.ts`, or how records are written.
- The matching-Bun, no-record case inside Kawai's push, which still runs the fallback.

## Decisions

### D1. The pin comes from the pushed commit's tree

For each pushed commit, `pre-push.ts` reads `git cat-file blob <commit>:.bun-version`, never the working tree or the index. The pushed tree is what the pin describes: the working tree may be another commit, and the index may be staged edits. The content is trimmed, and it is a usable pin only when it matches `^[0-9]+\.[0-9]+\.[0-9]+$`. An absent path, a failed read, empty content, or anything else means no pin, and the hook behaves as before. The pin is a function of the tree, so it is read once per tree, with the record lookups.

### D2. Two lookups, the same checks

`readTreeRecord(dir, treeId, now, bunVersion = Bun.version)` computes the content key for the given version on the running platform and architecture. It applies `readRecord`'s checks (shape, key field, TTL) and then requires `treeId`, `bun`, `platform`, and `arch` in the record to match the key's inputs. The hook looks up the running Bun first, then the usable pin when it differs. The first hit names its version, and the pass line names that version. No third version is ever tried. The pre-commit amend gate calls it without a version, so it keeps its running-Bun lookup.

Alternative rejected: accepting a record under any Bun version for the tree. That would let a pass under an arbitrary, possibly broken, Bun certify a tree whose pin names another one. The tree's own pin is the only version, besides the running one, that the tree claims to work with.

### D3. A mismatch with no pass refuses before any check

When neither lookup hits and the usable pin differs from the running Bun, the fallback check cannot help. It would run under the running Bun and record a key the tree's writer never used. Inside Kawai's push it would also outlive the remote timeout. So the hook refuses the ref even on a clean HEAD. The refusal names the ref, commit, tree, running Bun, and pinned Bun, and tells the writer to run `bun run check` under the pinned Bun on a clean checkout, then push. The not-checked-out and dirty refusals keep their own wording, with the pinned Bun named in their command when it differs. Q1 holds: with any ref refused, nothing is checked.

The refusal avoids the network wording that `classifyEffectFailure` treats as transient, such as "timed out" or "connection refused". With exit 1, Kawai therefore fails the push effect at once and does not retry it.

### D4. Pure decisions over gathered facts

`pushCheck.ts` stays pure. A commit's facts carry `bun` (the running version), `pin` (the usable pin or null), and `recordedBun` (the version whose record certified the tree, or null) in place of the old `recorded` flag. `pre-push.ts` gathers them, and `decidePush` decides from them alone. `parseBunPin` lives in `pushCheck.ts`, so the A2 grammar is tested without git. With `pin` null or equal to `bun`, every verdict and line is the old one, except that the pass line also names the accepted record's Bun version. `settleFallback` is unchanged: the fallback only runs under a matching or absent pin, so its exact-key check stays on the running Bun.

## Risks / Trade-offs

- [The certificate is looser: a pass under the pin, not the running Bun, lets the push through] → The pass covers the exact tree under the Bun version that tree pins, which is what CI and every writer of that tree run. Platform and architecture still have to match.
- [A writer cannot push from a host whose Bun differs from the pin without the pinned Bun installed] → The refusal names the command. Before this change, the same push ran an 18-minute check under the wrong Bun, or timed out inside Kawai.
- [A dirty path whose name contains network wording makes a dirty refusal read as transient] → Every path in the dirty and changed-during-the-check lists prints in an escaped, marked form (`\xHH`/`\u{HHHH}` for JS whitespace and every Unicode control character, backslashes doubled, a leading `//` no listed path can begin with, since porcelain paths are repository-relative), so the joined stderr carries no network wording and two listed paths never print the same. The hidden-entry refusal keeps its raw paths (a separate follow-up); its fixed text is tested against the classifier.

## Migration Plan

Land with the hook change. Records are unchanged, so nothing migrates. Rollback: revert the change. Archive after `per-result-suite` is archived, because this delta modifies a requirement that change adds.
