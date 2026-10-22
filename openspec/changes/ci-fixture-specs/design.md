# Design

## Context

- **The e2e job** in `.github/workflows/ci.yml` runs two Playwright steps after `bun run build`:
  - the main step, `bunx playwright test --workers=1`;
  - the fixture step, `NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test <27 spec paths> --workers=1`.

  The job runs only when its `if` holds: not cancelled, and the `changes` job did not classify the pull request as docs-only.
- **The specs.** On master at a491f364, 33 files under `tests/` mention `AGENTBOARD_CHAT_FIXTURE`, all under `tests/e2e/`.
  - 30 of them gate on it in the spec itself, with `test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', …)`.
  - The other 3 (`chat-external-cli`, `chat-real`, `chat-naming-real`) set it to `'0'`, as `AGENTBOARD_CHAT_FIXTURE: '0'`, in the env of the server they start.
  - No helper or fixture file mentions it.
- **Playwright's own listing.** `playwright test --list --reporter=json` loads the configuration and every spec it collects, then prints each test, without running any.
  - Playwright 1.57 is pinned in `bun.lock`. Its list mode runs only the load and report tasks, so no global setup, global teardown, or web server starts.
  - At load, it evaluates `test.skip` called at the top of a file or of a `describe`, including a call made through an imported helper.
  - Each test carries an `expectedStatus`: `skipped` for a test skipped at load, otherwise `passed`, or `failed` under `test.fail()`. Its `status` reads `skipped` for every test, because none runs.
  - `--reporter=json` replaces the configured reporters, so the listing writes no report.
  - The configuration's top-level code still runs. It only creates the temporary directory named by `E2E_TMUX_TMPDIR`, by default `abe2e-<time>` under the system temporary directory, and list mode never removes it.
  - One listing takes under a second on master.
- **Off and on.** On master, with `AGENTBOARD_CHAT_FIXTURE` unset and set to `1`, both listings hold 48 files and 96 tests.
  - In exactly 30 files, every test reads `skipped` with the variable unset and runnable with it set. They are the 30 specs gated in source.
  - 3 files read `skipped` both ways: the specs gated on the real-model opt-in.
  - The other 15 run both ways.
- **What the listing cannot see.** Playwright evaluates a `test.skip` inside a hook or a test body only when the test runs. Such a test reads as runnable in both listings.
- **The three unlisted specs.** `chat-activity`, `chat-auto-approve`, and `chat-workers` were run locally on master at 35d2d30b with the fixture step's command after `bun run build`, a fresh HOME, a spare `E2E_PORT`, and `--workers=1`. All 9 tests passed in 42 s. None of the three has changed since.
- **The shell.** A `run:` step without `shell:` runs under `bash -e`. A failing `$(…)` inside an argument list does not stop the script, but a failing assignment does.

## Goals / Non-Goals

**Goals:**
- CI's fixture step runs every spec file that has a test Playwright runs only with the fixture on.
- A new fixture spec needs no workflow edit.
- The unit suite fails on a return to a hand-written list, and on a narrowed, conditional, or failure-tolerant fixture step.

**Non-Goals:**
- Changing the specs, their gate, or the main e2e step.
- Splitting the fixture step, or sharding it.
- Renaming specs.
- Guarding what decides whether the e2e job runs at all: its `if` and `needs`, the `changes` job's docs-only classification, and the workflow's triggers. They decide for both e2e steps alike and stay ordinary workflow review.
- A variable name assembled at run time, such as `'AGENTBOARD_' + 'CHAT_FIXTURE'`, and a run-time gate in code outside `tests/`.

## Decisions

### D1. The lister asks Playwright

- **Two listings.** `scripts/e2e-fixture-specs.ts` runs `bunx playwright test --list --reporter=json` from the repository root, with the repository's configuration, twice:
  - once with `AGENTBOARD_CHAT_FIXTURE` removed from the environment;
  - once with it set to `1`.

  Each listing gets its own new directory as `E2E_TMUX_TMPDIR`, and the script removes both before it exits. The two may run in parallel.
- **The rule.** A file is listed when one of its tests has an `expectedStatus` other than `skipped` with the fixture on, and is `skipped` or absent without it.
  - Tests are matched by project name and title path, the titles of the enclosing `describe`s and the test.
  - `status` is never read.
- **The output.** The script prints the repository-relative path of each listed file, sorted by code unit, one per line. The path is the suite's `file`, joined to the listing's `config.rootDir`, made relative to the repository root.
- **Refusals.** The script exits 1, with a message on stderr, when:
  - either listing exits non-zero, or reports an entry in `errors`, such as a spec that fails to load;
  - either listing is not the JSON shape the script reads: `config.rootDir`, `suites`, and `errors`, with each test carrying a project name and an `expectedStatus`;
  - nothing is listed. A `playwright test` given no file arguments runs every spec, so an empty list must never reach it.
- **Granularity.** Playwright's command line selects files, so a listed file runs whole in the fixture step. Any of its tests that also run without the fixture then run in both steps. No listed file on master has such a test.
- **Following the configuration.** Because the listings load the real configuration, a changed `testDir`, `testMatch`, `testIgnore`, `grep`, or `projects` changes what is listed. No copy of Playwright's collection needs to keep up with it.
- **The shape.** The script has three parts:
  - a pure function over the two parsed listings, which returns the files or the refusal;
  - a runner, which takes the repository root and runs both listings;
  - a thin CLI, which uses the current directory.

  The tests drive the function over fixture listings, and the CLI over a temporary repository.
- **Rejected:**
  - Reading the spec sources for the gate's text, as the earlier drafts of this change did. That re-implements Playwright's collection and its evaluation of skips. Each review found one more case it missed: nested directories, a changed configuration, and a gate held by a helper.
  - A `*.fixture.spec.ts` naming convention. It renames 30 files, and a forgotten suffix still drops a spec silently.
  - A Playwright project or tag filter. It needs every spec edited and a config change for both steps.

### D2. The guards

The guard is a unit test, `scripts/__tests__/e2eFixtureSpecs.test.ts`. Its checks are pure functions, tested over fixture inputs and then run once over the real tree.

- **The list.** Over the real repository, the lister exits 0 and prints a non-empty list.
- **Readers.** Neither listing sees a skip inside a hook or a test body. A file the configuration stops collecting is absent from both listings. So the guard checks every file under `tests/` that the lister does not list, at any depth and of any name.
  - In such a file, each occurrence of the text `AGENTBOARD_CHAT_FIXTURE` must set it to `'0'`. That means the name, then `:` or `=`, then `'0'` or `"0"`. Whitespace may come between them, and so may a closing quote or bracket after the name.
  - Any other occurrence fails the test, naming the file. That includes one in a comment: the check reads text, and parses nothing.
  - A gate held by a helper fails as well, even where the listing would evaluate it. The one supported form is the gate in the spec itself, where the listing and this check agree. Supporting helpers would need the check to know which specs import a helper, and when they call it. No helper reads the variable today.
- **The step.** One positive rule says what the step may hold, instead of listing what it may not. In `ci.yml`, parsed with `Bun.YAML.parse`, the fixture variable appears in exactly one place: the `run` of the fixture step. It appears in no other step's `run` or `env`, in no job's `env`, and not in the workflow's `env`.
  - The step holds only `name` and `run`. So it has no `if`, `continue-on-error`, `shell`, `working-directory`, or `env`.
  - Its job has no `continue-on-error`.

  After continued lines are joined, and with blank and comment lines aside, that `run` is exactly two commands:
  1. `<name>=$(bun scripts/e2e-fixture-specs.ts)`.
  2. Environment assignments, then `bunx playwright test`.
     - The assignments' names come from an allowlist that the test holds: `AGENTBOARD_CHAT_FIXTURE`, which must be set to `1`, plus `NODE_ENV` and `E2E_PORT`.
     - Playwright's arguments are exactly one unquoted `$<name>`, naming the variable the first command assigns, plus options of the form `--<option>=<value>` from an allowlist the test holds. Today that allowlist is `workers` alone.

  Any other token or key fails the test, naming the step or the job. That includes:
  - a path or a bare spec name;
  - `tests/e2e` or `./tests/e2e`;
  - a glob;
  - a narrowing option such as `--grep`;
  - an option whose value is a separate word.

  Playwright reads every positional word as a filter on file paths.

Together these hold the invariant: every file under `tests/` that refers to the fixture variable, other than to set it to `'0'`, is listed, and the fixture step runs exactly the listed files with the fixture on.

### D3. The CI step

The fixture step's `run` becomes two lines:

```
specs=$(bun scripts/e2e-fixture-specs.ts)
NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test $specs --workers=1
```

The assignment makes a failing lister fail the step under `bash -e`. `$specs` is left unquoted on purpose: spec paths have no spaces, and word splitting turns the lines into arguments.

## Risks / Trade-offs

- [A spec gates inside a hook or a test body, which the listing cannot see] → The readers check fails on any file under `tests/` that the lister does not list and that refers to the variable other than to set it to `'0'`, naming the file.
- [A gate moves into a helper] → The readers check refuses the helper, naming it, even where the listing would see the gate. The gate stays in the spec.
- [The configuration stops collecting a fixture spec] → The spec is absent from both listings and still refers to the variable, so the readers check fails, naming it.
- [A run-time gate in code outside `tests/` that a spec imports] → Not caught. The server's fixture switch reads the variable under `src/`, so the readers check cannot cover `src/`.
- [A Playwright upgrade changes the JSON listing] → The lister refuses a shape it does not read, so the step fails rather than running nothing or every spec. The guard's run over the real tree fails first, in the unit suite.
- [A listed file also has tests that run without the fixture] → They run in both steps. No listed file on master has one.
- [The listings' cost] → Under a second each on master. They run in parallel, in CI before the fixture step and once in the unit suite.
- [The newly listed specs are slow or flaky in CI] → Locally, 9 tests took 42 s, and the job's 25-minute limit leaves room. A flaky spec is fixed like any other fixture spec.
- [The lister breaks] → The step fails at the assignment, before Playwright runs. It cannot run every spec by accident.

## Migration Plan

One PR holds the lister, its tests, and the `ci.yml` step. Rollback is a revert of that PR, which restores the hand-written list.

## Open Questions

None.
