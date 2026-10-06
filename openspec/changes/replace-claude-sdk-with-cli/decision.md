# Decision Note: SDK retention vs. CLI replacement (task 1.1)

Measured 2026-10-06 on linux-x64, Bun 1.4.2, `@anthropic-ai/claude-agent-sdk` 0.3.289 (bundles Claude Code 2.1.289), installed `claude` 2.1.291.

## Functional gap

None found. Kawai already uses the SDK's supported extension points for what this change targets:

- `spawnClaudeCodeProcess` — Kawai owns the child process; `wireTap.ts` records exact stdin/stdout/stderr lines for the debug view.
- `pathToClaudeCodeExecutable` — selects an externally installed CLI instead of the bundled one.

## Measured dependency cost

| Install | node_modules | SDK platform binaries |
| --- | --- | --- |
| Current (`bun install`) | 1019 MB | linux-x64 235 MB + linux-x64-musl 229 MB |
| `bun install --omit=optional` | 508 MB | none — but also drops lightningcss/oxlint/rolldown native bindings (breaks build/lint); not viable |
| `overrides` mapping the 8 `claude-agent-sdk-<platform>` packages to an empty local `file:` stub | 596 MB | none; other native bindings kept |

Bun 1.4.2 has `--os`/`--cpu` filters but no libc filter, so gnu and musl variants both install; overrides are the only targeted exclusion found.

## Handshake check (initialize only, no inference)

Probe: `query()` with streaming input, `settingSources: user,project,local`, `claude_code` preset, default permissions, deny-all `canUseTool`; await `initializationResult()`.

| Configuration | Result |
| --- | --- |
| Full install, bundled 2.1.289 | OK, 547 ms, 12 models / 66 commands |
| No binaries, no executable path | Fails fast: "Native CLI binary for linux-x64 not found … or set options.pathToClaudeCodeExecutable." |
| No binaries, `pathToClaudeCodeExecutable` = installed 2.1.291 | OK, 585 ms, 12 models / 66 commands |
| Overrides stub install, installed 2.1.291 | OK, 501 ms, 12 models / 66 commands |

Not yet verified under the lighter option: approvals, AskUserQuestion, inference turns, resume, and wire capture against a newer CLI than the SDK bundles (SDK/CLI version skew is the main residual risk).

## Release binaries cannot find the bundled CLI

Releases are `bun build --compile` binaries (linux-x64 asset in v1.0.0-21: 97.6 MB, so the 235 MB platform CLI is not embedded) and run without a sibling `node_modules`. A probe compiled the same way and run from an empty directory:

| Configuration | Result |
| --- | --- |
| Compiled, default bundled-binary lookup | FAIL: "Native CLI binary for linux-x64 not found …" |
| Compiled, `pathToClaudeCodeExecutable` = installed 2.1.291 | OK, 12 models |

So chat creation in released binaries currently fails its availability probe. An external executable path fixes this; full replacement would also, but with far more protocol code to own.

## Options compared

1. **Keep SDK as-is** — no work; ~464 MB binaries; bundled CLI drifts from installed CLI.
2. **Lighter option: SDK + external CLI** — stub the platform packages via `overrides`, pass `pathToClaudeCodeExecutable` (e.g. `KAWAI_CLAUDE_PATH` or `claude` on PATH), document separate CLI install. Removes ~423 MB and the drift; keeps SDK protocol handling; adds an SDK/CLI skew risk bounded by a minimum-version check.
3. **Full replacement (this change)** — removes the remaining 5.3 MB SDK package and SDK types; Kawai owns the internal control protocol, framing, lifecycle, and ~10 importing files.

## Decision

**Retain the SDK; do not implement full replacement.** Decided 2026-10-06 by the project owner. Option 2 captures nearly all the measured benefit of option 3 through supported SDK options without owning the internal control protocol. It is proposed separately as `use-external-claude-cli-with-sdk`. Tasks 1.2–5.3 of this change are not to be implemented; once the lighter option is applied and verified, this change should be withdrawn rather than archived as implemented.
