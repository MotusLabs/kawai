## 1. Delete npm packaging scaffolding

- [x] 1.1 Delete `npm/agentboard-darwin-arm64/`, `npm/agentboard-darwin-x64/`, `npm/agentboard-linux-x64/`, `npm/agentboard-linux-arm64/`, `bin/agentboard` (and the `bin/` directory if empty), and `scripts/update-optional-deps.js`. Verify: `git status` shows exactly those deletions; `grep -rn "update-optional-deps" . --exclude-dir=node_modules --exclude-dir=openspec` returns nothing.

- [x] 1.2 Remove the `optionalDependencies` sync block from `bumpVersion` in `scripts/release.ts` (the `if (packageJson.optionalDependencies) { ... }` loop around lines 278-284). Verify: `bun run typecheck` passes (script is outside tsconfig scope, but run it anyway) and `grep -n "optionalDependencies" scripts/release.ts` returns nothing.

## 2. package.json and lockfile

- [x] 2.1 Remove the `bin`, `files`, and `optionalDependencies` fields from `package.json`; keep `name`, `version`, `engines`, and all scripts untouched. Verify: `python3 -c "import json; d=json.load(open('package.json')); assert 'bin' not in d and 'files' not in d and 'optionalDependencies' not in d and d['version']"` and the `@gbasin/agentboard-*` packages are gone from the install graph.

- [x] 2.2 Regenerate `bun.lock` (`bun install`). Verify: `bun install --frozen-lockfile` succeeds cleanly afterwards and `grep -c "agentboard-linux-x64" bun.lock` returns 0.

## 3. README

- [x] 3.1 Remove the npm version badge (line 4). Verify: `grep -c "npmjs.com" README.md` returns 0 after the badge removal (before the Install rewrite also removes the other match, if any).

- [x] 3.2 Replace the Install section's Homebrew and npm/npx blocks with GitHub Releases instructions: a per-platform tarball download (darwin-arm64/x64, linux-x64/arm64) plus a copy-paste `curl -fsSL .../releases/latest/download/agentboard-<platform>.tar.gz | tar -xz` example, keeping the existing "open http://localhost:4040" and persistent-deployment pointers; include the one-line note that npm/Homebrew distributions are frozen at ≤ 0.5.x. Verify: manual read of the rendered section; `grep -n "npm install -g\|npx @gbasin\|brew tap gbasin" README.md` returns nothing.

## 4. Validation

- [x] 4.1 Run `bun run lint && bun run typecheck && bun run test:ci`. Verify: all green — proves nothing in the app or tooling depended on the deleted scaffolding.

- [x] 4.2 Manual (repo settings, outside the tree): delete the `HOMEBREW_TAP_TOKEN` secret from github.com/gbasin/agentboard settings. Verify: the secret is absent from Settings → Secrets → Actions.
