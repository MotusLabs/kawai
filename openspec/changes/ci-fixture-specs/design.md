# Design

## Context

- **The e2e job** in `.github/workflows/ci.yml` runs two Playwright steps after `bun run build`:
  - the main step, `bunx playwright test --workers=1`;
  - the fixture step, `NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test <27 spec paths> --workers=1`.
- **The specs.** On master at 45b74877, 33 specs under `tests/e2e/` mention `AGENTBOARD_CHAT_FIXTURE`.
  - 30 of them gate on it with `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', …)`, under one of two messages.
  - The other 3 (`chat-external-cli`, `chat-real`, `chat-naming-real`) set it to `'0'` in the env of the server they start.
  - No other file under `tests/` mentions it.
- **Collection.** `playwright.config.ts` sets `testDir: 'tests/e2e'`, and sets no `testMatch`, `testIgnore`, or `projects`.
  - With `testDir` set, Playwright 1.57 (pinned in `bun.lock`) reads no ignore files. It walks every directory under `tests/e2e/` except `node_modules`.
  - It collects the names that its default `testMatch`, `**/*.@(spec|test).?(c|m)[jt]s?(x)`, matches.
  - That is 48 files today, all top-level `*.spec.ts`. The subdirectories `fixtures/` and `support/` hold helpers only.
- **The three unlisted specs.** `chat-activity`, `chat-auto-approve`, and `chat-workers` were run locally on master at 35d2d30b with the fixture step's command after `bun run build`, a fresh HOME, a spare `E2E_PORT`, and `--workers=1`. All 9 tests passed in 42 s. None of the three has changed since.
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

- **The script.** `scripts/e2e-fixture-specs.ts` reads exactly the files Playwright collects, by the same walk (Context):
  - every directory under `tests/e2e/` except `node_modules`, at any depth;
  - each name matching `\.(spec|test)\.[cm]?[jt]sx?$`, the regular-expression form of the default `testMatch`.

  The script prints the repository-relative path of each file that carries the gate, sorted and one per line.
  - **The gate:** `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1'`, matched with `!=` or `!==` and with any whitespace.
  - **Comments are stripped before matching**, so a commented-out gate is not listed.
  - **One predicate.** The lister and D2's other-uses check share one `hasGate` function, so no file can count as gated for one and not for the other.
- **An empty result** exits 1, with a message on stderr. A `playwright test` given no file arguments runs every spec, so an empty list must never reach it.
- **The shape.** It has three parts:
  - a collector that walks a root directory;
  - a pure function over `{ path, source }` entries;
  - a thin CLI that runs both over the repository root, the current directory by default.

  The tests drive the collector over temporary trees, and the function over fixture entries.
- **Rejected:**
  - A `*.fixture.spec.ts` naming convention. It renames 30 files, and a forgotten suffix still drops a spec silently.
  - A Playwright project or tag filter. It needs every spec edited and a config change for both steps.

### D2. The guards

The guard is a unit test, `scripts/__tests__/e2eFixtureSpecs.test.ts`. Its checks are pure functions, tested over fixture inputs and then run once over the real tree:
- **The configuration.** In `playwright.config.ts`, with comments stripped:
  - `testDir` appears once, set to `'tests/e2e'`;
  - `testMatch`, `testIgnore`, and `projects` do not appear, since a project can set its own.

  Otherwise the test fails, naming the config, because Playwright would no longer collect what the lister reads.
- **The list.** The lister's output for the real tree is not empty.
- **Other uses.** This covers every file under `tests/` that does not carry the gate, at any depth and of any name, helpers included. Every code occurrence of `AGENTBOARD_CHAT_FIXTURE` in it must set the variable to `'0'`, either as `AGENTBOARD_CHAT_FIXTURE: '0'` or as `process.env.AGENTBOARD_CHAT_FIXTURE = '0'`.
  - Comments are stripped before matching.
  - Any other occurrence fails the test, naming the file. A gate in a new form, or one moved into a helper, is caught rather than dropped.
- **The step.** One positive rule says what the step may hold, instead of listing what it may not. In `ci.yml`, parsed with `Bun.YAML.parse`, the fixture variable appears in exactly one place: the `run` of the fixture step. It appears in no other step's `run` or `env`, in no job's `env`, and not in the workflow's `env`.

  After continued lines are joined, and with blank and comment lines aside, that `run` is exactly two commands:
  1. `<name>=$(bun scripts/e2e-fixture-specs.ts)`.
  2. Environment assignments that include `AGENTBOARD_CHAT_FIXTURE=1`, then `bunx playwright test`. Its arguments are exactly one unquoted `$<name>`, plus options of the form `--<option>=<value>` from an allowlist that the test holds. Today the allowlist is `workers` alone.

  Any other token fails the test, naming the step. That includes:
  - a path or a bare spec name;
  - `tests/e2e` or `./tests/e2e`;
  - a glob;
  - a narrowing option such as `--grep`;
  - an option whose value is a separate word.

  Playwright reads every positional word as a filter on file paths.

### D3. The CI step

The fixture step's `run` becomes two lines:

```
specs=$(bun scripts/e2e-fixture-specs.ts)
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test $specs --workers=1
```

The assignment makes a failing lister fail the step under `bash -e`. `$specs` is left unquoted on purpose: spec paths have no spaces, and word splitting turns the lines into arguments.

## Risks / Trade-offs

- [A spec gates in a form the lister does not recognize, or a helper holds the gate] → The guard fails on any use of the variable outside the gate or a `'0'` setting, in any file under `tests/`, naming the file.
- [A gate moved into code outside `tests/` that a spec imports] → Not caught. The server's fixture switch reads the variable under `src/`, so the check cannot cover it. The lister's header names the one gate form it reads.
- [The Playwright config starts collecting differently, such as another `testDir`, a `testMatch`, or a project] → The configuration check fails, naming the config, before a spec can be dropped silently.
- [A Playwright upgrade changes how it collects by default] → The walk in D1 follows Playwright 1.57. An upgrade re-reads its collector against D1.
- [The newly listed specs are slow or flaky in CI] → Locally, 9 tests took 42 s, and the job's 25-minute limit leaves room. A flaky spec is fixed like any other fixture spec.
- [The lister breaks] → The step fails at the assignment, before Playwright runs. It cannot run every spec by accident.

## Migration Plan

One PR holds the lister, its tests, and the `ci.yml` step. Rollback is a revert of that PR, which restores the hand-written list.

## Open Questions

None.
