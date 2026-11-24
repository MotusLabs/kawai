# Proposal

## Why

Kawai pushes a plan change from its worktree with the service's PATH Bun, now 1.4.5. The pre-push hook (`per-result-suite` D4) accepts a full-pass record only under the running Bun, because the content key includes the Bun version. A branch created from an older base pins another Bun in its `.bun-version` (1.4.3), and its writer certifies the tree under that pin. The hook finds no record under 1.4.5. On a clean HEAD it then runs the full `bun run check`, which takes about 18 minutes. Git kills it at Kawai's 120 s remote timeout, the effect retries three times, and the change stops as "push timed out" although the transport is fine. This happened on 2026-11-19 and on 2026-11-23 (Foundation effect-81226696). Until now, writers have worked around it by pushing by hand under the pinned Bun.

## What Changes

- The hook reads each pushed commit's own pin from its tree (`<commit>:.bun-version`). A usable pin is the trimmed content in `MAJOR.MINOR.PATCH` form.
- A recorded full pass for the tree under the running Bun or under that pin certifies the tree, on the running platform and architecture only. No other version, tree, platform, or architecture is accepted.
- With no such pass and a pin that differs from the running Bun, the hook refuses the ref at once and starts no check. The refusal names the running and pinned Bun and the command: `bun run check` under the pinned Bun on a clean checkout, then push. Kawai's effect classifier reads that refusal as permanent, so the push fails at once instead of timing out three times.
- With no usable pin, or a pin equal to the running Bun, the hook behaves as before, including the clean-HEAD fallback check.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dev-checks`: the requirement "Pushes require a full check of the pushed tree", added by the unarchived `per-result-suite` change, also accepts a pass under the commit's pinned Bun and refuses a Bun mismatch without running a check.

## Impact

- `scripts/pre-push.ts`, `scripts/lib/pushCheck.ts`, `scripts/lib/treeRecord.ts`, `.githooks/pre-push`, and their tests.
- AGENTS.md's pre-push paragraph.
- Unchanged: the pre-commit hook's message-only amend gate (running Bun only), `scripts/check.ts`, record writing, and Kawai's push effect and its timeout. A push under a matching Bun with no record still runs the fallback check inside Kawai's push, which is a separate follow-up.
