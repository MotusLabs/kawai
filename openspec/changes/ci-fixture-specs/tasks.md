# Tasks

## 1. Lister and guards

- [ ] 1.1 Add `scripts/e2e-fixture-specs.ts` (D1): the collector, the pure function, and the CLI. The CLI prints the sorted repository-relative paths, one per line, or exits 1 with a stderr message when there are none.

  Verify the pure function over fixture entries:
  - both gate messages, with `!=` and with `!==`, and with extra whitespace;
  - a newly added gated spec, which is listed with no other input changed;
  - a gate that is commented out, and a spec that mentions the variable only in a comment: neither is listed;
  - a spec that sets the variable to `'0'`, and one gated only on `KAWAI_REAL_CHAT_TEST`: neither is listed.

  Verify the collector over a temporary tree:
  - a gated spec two directories deep is read;
  - the names `a.spec.ts`, `b.test.mjs`, `c.spec.cts`, and `d.test.tsx` are read;
  - `helper.ts` and `e.spec.d.ts` are not;
  - a spec under a `node_modules` directory is not.

  Verify the CLI, run in that temporary tree:
  - it prints the nested spec's path;
  - over a tree with no gated spec, it exits 1 with a stderr message.
- [ ] 1.2 Add the guard checks as pure functions, and the guard test over the real tree (D2). Verify with fixture inputs that each check fails, naming its subject, in each of these cases:
  - Beside `$specs` and `--workers=1`, the fixture step's Playwright arguments add any of: a `tests/e2e/` path, a bare `chat.spec.ts`, `tests/e2e`, `./tests/e2e`, a glob, `--grep=chat`, or `--workers 1`.
  - The fixture `run` lacks the assignment, has a third command, or passes a variable other than the one it assigns.
  - The variable appears in another step's `run` or `env`, or in a job's `env`.
  - The config has another `testDir`, a `testMatch` or `testIgnore`, or `projects`.
  - A file without the gate reads the variable in code: a spec at the top level, a spec in a subdirectory, and a helper under `tests/e2e/support/`.

  Also verify that:
  - the same inputs pass when the variable appears only in comments;
  - the real tree passes.

## 2. CI step

- [ ] 2.1 Switch the fixture step to the two-line `run` (D3). Verify:
  - `Bun.YAML.parse` reads `ci.yml`, and the guard test passes over the real tree;
  - the lister prints the 30 gated specs, the three newly listed ones among them;
  - those three pass locally under CI's fixture setup: after `bun run build`, with a fresh HOME, a spare `E2E_PORT`, and `--workers=1`, and never through `bun run test:e2e`;
  - the pull request's e2e job passes, and its fixture step's log names the three specs.
