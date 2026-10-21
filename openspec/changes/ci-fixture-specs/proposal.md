# Proposal

## Why

CI's fixture e2e step names its specs by hand, on one `run:` line of `ci.yml`. Three fixture-gated specs were never added to it: `chat-activity`, `chat-auto-approve`, and `chat-workers`.
- The main e2e step skips them, because the fixture is off there.
- The fixture step never names them.

As a result, none of their 9 tests has ever run in CI. They pass locally under CI's fixture setup: 9 passed on master at 35d2d30b.

Every new fixture spec also edits that same line, so parallel branches collide on it.

The change is small and independent. That also makes it the first change the team runs through Kawai's plan execution.

## What Changes

- **A lister.** `scripts/e2e-fixture-specs.ts` asks Playwright which spec files have a test that runs only with the development chat fixture on.
  - It takes Playwright's own listing of the suite twice, with the fixture off and on, and prints the files whose tests flip from skipped to runnable, sorted.
  - It exits non-zero when a listing fails or nothing flips.
- **The CI step.** CI's fixture step runs Playwright on the lister's output. The three specs start running, and a new fixture spec needs no workflow edit.
- **A guard.** A unit-suite guard fails when:
  - the workflow's fixture step passes Playwright anything besides the lister's output and the allowed options and environment;
  - the step is made conditional or allowed to fail;
  - the fixture variable appears elsewhere in the workflow;
  - a file under `tests/` that the lister does not list refers to the fixture variable for anything but setting it to `0`. This catches the gates Playwright evaluates only while a test runs, gates in helpers, and specs the configuration stops collecting.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `github-workflows`: the fixture e2e step runs every fixture-gated spec, and the specs themselves supply the list.

## Impact

- `scripts/e2e-fixture-specs.ts` is new, with its unit tests.
- `.github/workflows/ci.yml`: the fixture step's `run:` changes.
- Nothing changes in the server, the client, or AGENTS.md. The specs and their gate stay as they are.
- The sibling proposal `independent-verification` (PR #271, not yet merged) leaves the fixture list to this change.
