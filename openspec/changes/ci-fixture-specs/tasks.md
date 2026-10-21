# Tasks

## 1. Lister and guards

- [ ] 1.1 Add `scripts/e2e-fixture-specs.ts` (D1): the pure function over two listings, the runner, and the CLI. The CLI prints the sorted repository-relative paths, one per line, or exits 1 with a stderr message.

  Verify the pure function over fixture listings:
  - A test skipped without the fixture and runnable with it lists its file. So does a test absent without the fixture and runnable with it.
  - A file whose tests run both ways is not listed. Neither is a test skipped both ways.
  - A `test.fail()` test, whose `expectedStatus` is `failed`, counts as runnable.
  - Tests are matched by project and title path. Two projects, one of which flips, list the file once. Two tests with the same title in different `describe`s are told apart.
  - Every test reading `status: skipped` changes nothing: only `expectedStatus` is read.
  - Each of these is refused, naming its cause:
    - an entry in `errors`;
    - a missing `config.rootDir` or `suites`;
    - a test without `expectedStatus`;
    - an empty result.

  Verify the runner and the CLI over a temporary repository. It holds a configuration with `testDir: 'tests/e2e'`, the specs below, and a `node_modules` link to the repository's.
  - The CLI prints:
    - a spec gated at the top of the file;
    - a spec gated in a `describe`, two directories deep;
    - a spec gated through an imported helper.
  - It does not print an ungated spec, a spec that sets the variable to `'0'`, or a spec skipped both ways.
  - A spec that fails to load makes it exit 1, with the load error on stderr.
  - A tree with no gated spec makes it exit 1, with a stderr message.

  Verify over the real repository, with the system temporary directory pointed at a new empty directory: the run leaves that directory empty.
- [ ] 1.2 Add the guard checks as pure functions, and the guard test over the real tree (D2). Verify with fixture inputs that each check fails, naming its subject, in each of these cases:
  - Beside `$specs` and `--workers=1`, the fixture step's Playwright arguments add any of: a `tests/e2e/` path, a bare `chat.spec.ts`, `tests/e2e`, `./tests/e2e`, a glob, `--grep=chat`, or `--workers 1`.
  - The fixture `run`:
    - lacks the assignment;
    - has a third command;
    - passes a variable other than the one it assigns;
    - assigns the list but passes Playwright no `$<name>` at all.
  - An assignment outside the allowlist comes before `bunx playwright test`, or `AGENTBOARD_CHAT_FIXTURE=1` is missing.
  - The step gains `if: false`, `continue-on-error: true`, `shell`, `working-directory`, or `env`. The job gains `continue-on-error`.
  - The variable appears in another step's `run` or `env`, in a job's `env`, or in the workflow's `env`.
  - Files the lister does not list refer to the variable other than to set it to `'0'`. Each must fail, naming the file:
    - a spec at the top level that gates in `beforeEach`;
    - a spec in a subdirectory that gates in a test body;
    - a helper under `tests/e2e/support/`;
    - a file under `tests/fixtures/`;
    - a mention in a comment;
    - a spec that the configuration no longer collects.

  Also verify that:
  - `'0'` settings pass in both forms, `AGENTBOARD_CHAT_FIXTURE: '0'` and `process.env.AGENTBOARD_CHAT_FIXTURE = '0'`, with either quote;
  - a listed file passes whatever it reads;
  - the real tree passes. The lister prints a non-empty list, the readers check passes over `tests/`, and the step check passes over `ci.yml`.

## 2. CI step

- [ ] 2.1 Switch the fixture step to the two-line `run` (D3). Verify:
  - `Bun.YAML.parse` reads `ci.yml`, and the guard test passes over the real tree;
  - the lister prints the 30 gated specs, and the three newly listed ones are among them;
  - those three pass locally under CI's fixture setup: after `bun run build`, with a fresh HOME, a spare `E2E_PORT`, and `--workers=1`, and never through `bun run test:e2e`;
  - the pull request's e2e job passes, and its fixture step's log names the three specs.
