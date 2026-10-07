# Design

## Context

Today `src/server/chat/ClaudeProfiles.ts` holds the profile catalog as a compiled array, hand-mirrored from `/usr/local/bin/claude-provider`. Profile selection, persistence (`profile_id` in `chat_sessions`), merge with the global provider environment (`PROFILE_CONTROLLED_ENV` replacement), availability probing, and the identifier-only client contract all exist and stay; only the catalog source, its merge rules, and an optional per-profile executable are new. See `proposal.md` for motivation.

## Goals / Non-Goals

**Goals:**

- Profiles defined in `.kawai/profiles.json` files, layered like Claude Code settings.
- One source of truth for both the chat picker and session launch; no code changes or redeploys to add a profile.
- Catalog entries may delegate to an operator-trusted wrapper executable.
- Catalog files stay non-secret: committable, ConfigMap-mountable.

**Non-Goals:**

- Terminal commands of any kind. Kawai writes no executables and manages no shims; `/usr/local/bin/claude-*` wrappers remain user-maintained for terminal use.
- A UI for defining profiles. The Settings provider-env panel keeps its current role unchanged (environment merge base and credential store).
- Credentials in catalog files, hot-reload/file watching, and per-project PATH manipulation.

## Decisions

### D1: Catalog resolution — walk-up merge, replace-not-merge at deployment level

Resolve(server-side, session project path): collect `profiles.json` from every `.kawai` directory between the project path (realpath, to normalize worktree symlinks) and `/`, layered above the user-level `~/.kawai/profiles.json`. The user-level file **replaces** the image-provided default outright when present; partial merging baked+mounted makes "which value wins where" ambiguous, and the K8s idiom is a complete ConfigMap. The resolved catalog always contains `default` — an implicit empty entry when no file defines it — because omitted profile selections resolve to it; a replacement catalog cannot remove it.

Alternatives: keeping the compiled array with an optional override file (rejected — two sources again); merging baked+mounted (rejected above).

### D2: Merge semantics — per environment key, nearest wins, `""` neutralizes

Same id at multiple levels merges field-by-field: `env` merges per key (nearest wins, empty string removes the inherited value), and scalar fields (`label`, `model`) are taken from the nearest file that sets them. `executable` is not a mergeable scalar — it is settable only at the user level (D4). This is what makes "extend" work: a worktree file with one model override inherits everything else. Reusing `""`-as-neutralize keeps one semantic already present in `PROFILE_CONTROLLED_ENV` handling.

Alternative: whole-profile replace (rejected — the dangling `claude-glm-flash` case is exactly a one-knob tweak).

### D3: Catalog env keys restricted to the profile-controlled allowlist

Valid catalog `env` keys are exactly the `PROFILE_CONTROLLED_ENV` set (routing, model, attribution, compaction). Unknown keys — in particular credential keys like `ANTHROPIC_AUTH_TOKEN` — fail validation with an error naming the file. This enforces the spec's "catalog files carry no credentials" structurally instead of by convention, and keeps files safe to commit. Allowlist growth is a code change, deliberately.

### D4: `executable` — user-level trust only, launched via the SDK's executable option

Only the user-level catalog (`~/.kawai/profiles.json`, a mounted ConfigMap in deployments) may name an `executable`. Project-discovered `.kawai` files are agent-writable: an entry there naming an executable is a validation error and the file is isolated per D6. Without this restriction an agent could redefine a profile it knows will be used, pointing it at arbitrary code that runs with the server's credentials on next spawn. The trust boundary is the operator who writes the user-level file — the same trust already granted to `AGENTBOARD_CHAT_ENV` — and the client API stays identifier-only.

Launch: the executable replaces the standard binary (SDK `pathToClaudeCodeExecutable`; the future CLI driver spawns it directly) and receives the merged base environment including credentials; entry `env` is pre-applied and the executable's own exports win, which is how the existing wrapper pattern behaves. For executable-backed profiles kawai injects **no inline controlled settings** — those settings exist to override conflicting user/project Claude configuration for env-based profiles, and injecting them would defeat the executable's own configuration. The executable is the configuration authority; the main spec's settings-precedence requirement governs env-based profiles only. Missing or non-executable path → actionable error before agent start, same class as the missing-Claude-Code-binary failure.

Rejected alternative: kawai-generated terminal shims (with ownership markers, PATH-shadowing diagnostics, stale cleanup). Dropped: it served only terminal ergonomics, forced kawai to write executables into the user's namespace, and couldn't express wrappers needing real shell logic (auth refresh, login-before-exec). Documented here as the reason kawai never writes executables.

### D5: Resolution timing — read on demand, store only the identifier

The picker endpoint resolves the catalog for the requested project path per fetch; session creation and agent spawn re-resolve at that moment. Nothing is cached beyond the request, and only the profile id is persisted (existing column). Files changing between picker load and spawn therefore surface as the existing "unknown profile" actionable error rather than stale behavior. Reads are a handful of small JSON files; no caching complexity in v1.

### D6: Validation and failure isolation

File shape: object keyed by profile id (`^[a-z0-9][a-z0-9-]*$`, also future-proofing any filename use), each entry **partial** — any subset of `label`, `env` (string values), and `model`, plus `executable` in user-level files only (D4). Requiring complete entries would defeat per-key extension: a worktree file may carry nothing but a model override. Required-field validation runs on the **merged** profile, and the only post-merge requirement is a display label: a profile with no label at any level falls back to its id, so the picker always has one. Caps mirror the provider-env limits (≤32 vars per profile, ≤4096 chars per value). A malformed or unreadable file — including a project-level file naming an executable — produces an error identifying the path; other discovered files still resolve — one bad `.kawai` file must not blank the picker.

### D7: Probe identity includes the executable

`claudeLaunchKey` (the availability-probe cache key) extends to cover the resolved executable, so two profiles differing only by wrapper probe separately. Spec scenario "Executable differences use separate probes" falls out of this.

## Risks / Trade-offs

- [Catalog files are readable/editable by chat agents working in the repo] → Enforced rather than accepted: credentials are structurally excluded (D3) and executables are restricted to the operator-owned user level (D4), so the agent-writable blast radius is provider routing only.
- [Profile vanishes when a file is renamed between session creation and resume] → Existing spec behavior already covers it: session retained, actionable error, no silent substitution.
- [Walk-up discovery reads on every fetch] → Deliberate (D5); revisit with mtime caching only if profiling shows it matters.
- [Allowlisted env keys may lag a new routing variable Claude Code grows] → Small, explicit code change to extend `PROFILE_CONTROLLED_ENV`; preferable to accepting arbitrary keys.

## Migration Plan

1. Ship the current six profiles as the image-default catalog file (in-repo, e.g. `config/profiles.default.json`, copied into the image); `~/.kawai/profiles.json` may replace it.
2. Delete the hardcoded array from `ClaudeProfiles.ts`; resolution, merge, executable handling, and per-path catalog endpoint land together.
3. No DB migration (`profile_id` unchanged); Settings-stored env unchanged; `/usr/local/bin` wrappers untouched.
4. Sequencing: land before `replace-claude-sdk-with-cli` continues, so the CLI driver consumes the file-backed catalog directly.
5. Rollback: revert the deploy; catalog files left on disk are inert without the new code.
