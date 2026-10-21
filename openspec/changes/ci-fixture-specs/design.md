# Design

## Context

- **The e2e job** in `.github/workflows/ci.yml` runs two Playwright steps after `bun run build`:
  - the main step, `bunx playwright test --workers=1`;
  - the fixture step, `NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test <26 spec paths> --workers=1`.
- **The specs.** 32 specs under `tests/e2e/` mention `AGENTBOARD_CHAT_FIXTURE`.
  - 29 of them gate on it with `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', …)`, under one of two messages.
  - The other 3 (`chat-external-cli`, `chat-real`, `chat-naming-real`) set it to `'0'` in the env of the server they start.
- **The three unlisted specs.** `chat-activity`, `chat-auto-approve`, and `chat-workers` were run locally on master at 35d2d30b with the fixture step's command after `bun run build`, a fresh HOME, a spare `E2E_PORT`, and `--workers=1`. All 9 tests passed in 42 s.
- **The shell.** A `run:` step without `shell:` runs under `bash -e`. A failing `$(…)` inside an argument list does not stop the script, but a failing assignment does.

## Goals / Non-Goals

**Goals:**
- CI's fixture step runs every fixture-gated spec.
- A new fixture spec needs no workflow edit.
- Going back to a hand-written list fails the unit suite.

**Non-Goals:**
- Changing the specs, their gate, or the main e2e step.
- Splitting the fixture step, or sharding it.
- Renaming specs.

## Decisions

### D1. The lister reads each spec's own gate

- **The script.** `scripts/e2e-fixture-specs.ts` reads `tests/e2e/*.spec.ts` (the top level, Playwright's `testDir`). It prints the repository-relative path of each spec that carries the gate, sorted and one per line.
  - **The gate:** `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1'`, matched with `!=` or `!==` and with any whitespace.
- **An empty result** exits 1, with a message on stderr. A `playwright test` given no file arguments runs every spec, so an empty list must never reach it.
- **The shape.** The logic is a pure function over `{ path, source }` entries, with a thin CLI around it, so the tests drive the function directly.
- **Rejected:**
  - A `*.fixture.spec.ts` naming convention. It renames 29 files, and a forgotten suffix still drops a spec silently.
  - A Playwright project or tag filter. It needs every spec edited and a config change for both steps.

### D2. The guards

The guard is a unit test, `scripts/__tests__/e2eFixtureSpecs.test.ts`. Its checks are pure functions, tested over fixture inputs and then run once over the real tree:
- **The list.** The lister's output for the real tree equals the set of specs that carry the gate, and it is not empty.
- **Other uses.** Every code occurrence of `AGENTBOARD_CHAT_FIXTURE` in a spec without the gate sets it to `'0'`, either as `AGENTBOARD_CHAT_FIXTURE: '0'` or as `process.env.AGENTBOARD_CHAT_FIXTURE = '0'`. Comments are stripped before matching. Any other occurrence fails the test, naming the spec, so a new gate form is caught rather than dropped.
- **The step.** In `ci.yml`, parsed with `Bun.YAML.parse`, exactly one step's `run` sets `AGENTBOARD_CHAT_FIXTURE=1`. That `run`:
  - captures the lister's output in an assignment line;
  - names no `tests/e2e/` path.

  A failure names the step.

### D3. The CI step

The fixture step's `run` becomes two lines:

```
specs=$(bun scripts/e2e-fixture-specs.ts)
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test $specs --workers=1
```

The assignment makes a failing lister fail the step under `bash -e`. `$specs` is left unquoted on purpose: spec paths have no spaces, and word splitting turns the lines into arguments.

## Risks / Trade-offs

- [A spec gates in a form the lister does not recognize] → The guard fails on any use of the variable outside the gate or a `'0'` setting, naming the spec.
- [The newly listed specs are slow or flaky in CI] → Locally, 9 tests took 42 s, and the job's 25-minute limit leaves room. A flaky spec is fixed like any other fixture spec.
- [The lister breaks] → The step fails at the assignment, before Playwright runs. It cannot run every spec by accident.

## Migration Plan

One PR holds the lister, its tests, and the `ci.yml` step. Rollback is a revert of that PR, which restores the hand-written list.

## Open Questions

None.
