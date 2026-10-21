# Tasks

## 1. Lister and guards

- [ ] 1.1 Add `scripts/e2e-fixture-specs.ts` (D1). It holds a pure function over `{ path, source }` entries, and a CLI that prints the sorted repository-relative paths, one per line, or exits 1 with a stderr message when there are none. Verify with unit tests over fixture entries:
  - both gate messages, with `!=` and with `!==`, and with extra whitespace;
  - a spec that mentions the variable only in a comment;
  - a spec that sets the variable to `'0'`;
  - the CLI's exit code and stderr for an empty list.
- [ ] 1.2 Add the guard checks as pure functions, and the guard test over the real tree (D2). Verify with fixture inputs that each check fails, naming its subject, on:
  - a fixture step that names a `tests/e2e/` path;
  - a fixture step that does not assign the lister's output;
  - a spec without the gate that reads the variable in code.

  Also verify that the same input with the variable only in a comment passes.

## 2. CI step

- [ ] 2.1 Switch the fixture step to the two-line `run` (D3). Verify:
  - `Bun.YAML.parse` reads `ci.yml`, and the guard test passes over the real tree;
  - the lister prints 29 specs, the three newly listed ones among them;
  - those three pass locally under CI's fixture setup: after `bun run build`, with a fresh HOME, a spare `E2E_PORT`, and `--workers=1`, and never through `bun run test:e2e`;
  - the pull request's e2e job passes, and its fixture step's log names the three specs.
