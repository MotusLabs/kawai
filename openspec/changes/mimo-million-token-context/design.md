# Design

## Context

See proposal.md for motivation, sources, and the 2026-11-18 update. Current
inventory on master `f52963d0` (static read):

| Path | Today |
|---|---|
| `config/profiles.default.json:14-24` | MiMo legacy entry: `mimo-v2.6-pro` startup and Opus/Haiku/Fable, `mimo-v2.6-flash` Sonnet, no `[1m]`, no window |
| `src/server/chat/catalogParse.ts:24` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is an allowed catalog env name (untyped string) |
| `src/server/chat/catalogMerge.ts:1-12` | one layered merge: farthest first; same-id providers merge, nearer scalar wins, env merges per key; shipped model keys re-home with their flattened settings |
| `src/server/chat/ClaudeProfiles.ts:195-225` | `resolveClaudeProfile`: registered names withheld (`catalogRegisteredNames`), `RegisteredNameRefusal('credentialed' \| 'named-profile', …)` for colliding controlled/pinned/blank keys, controlled keys blanked in `settings.env` |
| `src/server/chat/provider/claudeRuntimeLaunch.ts:73-97` | `claudeSpawnLaunch`: resolves the profile per spawn, builds `launch.childEnv` and `settingsEnv` |
| `src/server/chat/provider/claudeRuntimeLaunch.ts:162-176` | `launchFields`: passes `settings: { env: settingsEnv }` to the package |
| `src/server/chat/provider/claudeRuntime.ts:319-345` | `ensure()` calls `claudeSpawnLaunch` at every start and respawn; `innerOptions` adds `getEffort()` |
| `packages/agent-runtime/src/options.ts:250` | `settings?: { env? }` only — no typed inline compaction settings |
| `packages/agent-runtime/src/claude/usageFacts.ts:133`, `src/server/chat/provider/claudeContextMirror.ts:55` | the context tracker takes the profile window from `childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| `src/server/chat/ChatSessionManager.ts:1640-1650` | start record and settings observation read `info.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| `src/server/chat/ChatSessionManager.ts:2878-2882`, `src/server/team/sessionTeams.ts:155-161` | `getEffort` → `SessionTeams.effortFor(session, group, profile)`: `profileEffort[profile] ?? effort` |
| `src/server/team/groupCatalog.ts:125-158`, `workspaceRead.ts:107` | `profileEffort` qualified-key resolution, duplicate warnings, read-only metadata |

## Goals / Non-Goals

**Goals:** keep capacity, compaction preference, and observed threshold
separate; configure MiMo at 300000 tokens; let roles specialize it per profile
without duplicating model profiles.

**Non-Goals:** output-budget changes, an in-chat editor, disabling
auto-compaction through the new field, Codex compaction, operator file edits,
staffing changes, any `packages/agent-runtime` API change or publication, and
relay install modes.

## Decisions

### D1: Capacity stays in the model declaration

Tag MiMo's startup model and every tier mapping with `[1m]`, preserving
Pro/Flash and the base URL. Ship `autoCompactWindow: 300000` separately. When a
selected numeric preference applies to a launch whose model declaration
explicitly carries `[1m]`, the launch clears `CLAUDE_CODE_DISABLE_1M_CONTEXT`
in both env layers, subject to D3's refusal; otherwise that flag keeps its
behavior and capacity is never inferred from a window.

### D2: Typed preferences in catalogs and roles

Optional `autoCompactWindow` on legacy Claude profiles, providers, and
provider models: JSON integer in [100000, 1000000]. Invalid values reject the
file through existing file-level isolation. Claude-only: a Codex entry or a
resolved executable-backed entry carrying it is an incompatibility error.

The scalar flows through parse, merge, flatten, embedded defaults, and
shipped-model re-homing like other provider scalars: nearer wins, a model's
scalar overrides its provider's, and a project overlay that omits it inherits
the base value (`catalogMerge.ts`). The base is the user-level `~/.kawai`
files when either exists, else the shipped defaults (`profileCatalog.ts:47`),
so a user-level catalog never receives the shipped preference.
*Refinement (proposed):* the former relay install-mode rules (durable mode,
retained layers, trim) are dropped because master has none of them; a later
relay change that adds them re-derives this rule.

Roles accept `autoCompactWindow: 250000` and
`profileAutoCompactWindow: { mimo: 300000 }`, a single-line flow map keyed by
profile id with qualified keys (`mimo/mimo`) resolved exactly as
`profileEffort` is. Plain decimal integer tokens only. Invalid
defaults/maps/entries are warnings; a repeated written key is consumed by its
first occurrence even if invalid; among keys resolving to one profile the
first valid entry wins; unknown keys are ignored with a warning; a known
profile outside the role's workers warns and still applies.

Resolution for a supported Claude process: role per-profile value > role
default > flattened catalog scalar > existing env/runtime behavior. Ungrouped
sessions use the catalog scalar. Human-created and staffed members resolve
alike. Codex and wrapper-backed launches ignore role preferences.

### D3: One effective value reaches every launch consumer

`SessionTeams.compactWindowFor(session, group, profile)` mirrors `effortFor`,
read through a manager callback (`getCompactWindow`) at each start and
respawn. `claudeSpawnLaunch` applies the selected value after
`resolveClaudeProfile`, before `launchFields` and the package see the launch.

C is the composed key set: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, and `CLAUDE_CODE_DISABLE_1M_CONTEXT`
only under D1's condition; with no selected value C is empty and the launch
is untouched. R is the per-spawn registered-name set `resolveClaudeProfile`
already derives. If C ∩ R is nonempty, the spawn throws
`RegisteredNameRefusal` with the colliding names only, before either layer is
written, on Default as on named and credentialed branches; the send settles
failed and no child starts. C is never added to R.

With an empty intersection the window is set and the two (or three) disable
switches are set to empty strings in `launch.childEnv` and in `settingsEnv`
(created when absent). *Refinement (proposed):* no inline
`autoCompactEnabled`/`autoCompactWindow` settings are composed, because the
package's `settings` carries env only; an operator's own global
`autoCompactEnabled: false` is outside this change (X3) and R1 records the
effective state. Shared process env is never mutated; the typed preference
wins over a legacy catalog env window.

The tracker, start record, and settings observation already read the launch
env (`usageFacts.ts:133`, `claudeContextMirror.ts:55`,
`ChatSessionManager.ts:1647`), so they see the normalized window. Report
precedence, reserve subtraction, and approximation labels stay. Read-only
group metadata (`workspaceRead.ts`, `TeamMemberRow`) exposes the role default,
resolved per-profile map, and warnings. No new persisted columns.

## Acceptance oracles

Commit the tables verbatim as table-driven tests. `*` = irrelevant.

| ID | Role profile value | Role default | Catalog scalar | Legacy env window | Effective window / switches cleared |
| --- | --- | --- | --- | --- | --- |
| W1 | 300000 | 250000 | 400000 | 150000 | 300000 / yes |
| W2 | absent | 250000 | 400000 | 150000 | 250000 / yes |
| W3 | absent | absent | 300000 | 150000 | 300000 / yes |
| W4 | absent | absent | absent | 150000 | 150000 / no change |
| W5 | absent | absent | absent | absent | runtime default / no change |

| ID | Input / seam | Observable result |
| --- | --- | --- |
| C1 | Shipped MiMo, empty isolated home, `resolveClaudeProfile` + `claudeSpawnLaunch` | Pro startup/Opus/Haiku/Fable and Flash Sonnet tagged `[1m]`, original URL, window 300000 in both layers |
| C2 | Provider 400000, model 300000 | that model 300000; sibling without own scalar 400000 |
| C3 | Far model 300000, near model 400000; then a shipped key re-homed without scalar | near 400000; re-homed key keeps its inherited scalar |
| C4 | Catalog scalar string, boolean, null, fractional, 99999, 1000001 | whole file reported and skipped; another valid file usable |
| C5a | A user-level catalog defines `mimo` without the scalar | no shipped 300000 injected (user level replaces the shipped defaults) |
| C5b | A project overlay redefines `mimo` models without the scalar over a base declaring 300000 | inherits 300000 |
| G1 | Role default invalid, or map malformed | group kept; field warned and ignored; valid fallback applies |
| G2 | Invalid/unknown/wrong-qualified map entry plus valid sibling | bad entry warned alone; sibling applies |
| G3 | Repeated written key, or two valid keys resolving to one profile | first written occurrence consumed; first valid resolved entry wins; later duplicate warned |
| G4 | Known profile not in the role's workers, bare and qualified | warning; applies to a human-created member on that profile |
| L1 | Real manager starts human-created and staffed MiMo members with a role override | both package launches carry the same window in `childEnv` and `settings.env`, switches blank; tracker and start observation use it |
| L2 | Role value edited while running, restart, value removed, restart | running launch unchanged; next start uses the edit; removal falls back |
| L3 | Two concurrent sessions, preference only on the first | first overridden; second keeps its default; `process.env` unchanged |
| L4 | Codex or wrapper-backed member with a role preference | existing launch; no role-composed keys |
| L5 | Catalog scalar on a Codex or executable-backed Claude entry | actionable incompatibility error |
| L6 | A composed key registered after driver creation (binding then removed), at start and respawn, Default and named/credentialed branches | `RegisteredNameRefusal` names-only, settled failed send, zero package launches, no composed key in either layer |
| L7 | Noncolliding preference at start and respawn | both succeed; registered and retained name sets unchanged; a later real registration flips the next spawn to L6 |
| M1 | Window 300000, first usage without report; then report threshold 267000 / raw 300000 / reserve 33000 | approximate 300000 first, then exact 267000; reported facts win |
| V1 | Read-only group metadata | default, resolved per-profile map, warnings present |
| R1 | Actual supported CLI at `CLAUDE_CODE_MIN_VERSION` with the normalized MiMo launch (owner credentials) | 1M capacity recognized, effective enablement and 300K window with the real reserve, accepted untagged outgoing model ids; missing baseline/report/credentials reads as unverified |

Unreachable: a role selection for a session without that role; former row
C5c (retired retained layers do not exist on master). Hazards consulted
(`docs/oracle-hazards.md`): L1 runs the production manager and
`claudeSpawnLaunch` (M1); L6 covers a registered set frozen at creation and a
branch re-composing a filtered name.

Property P1: a chosen override never leaks to another session or the process
env. Generator: two isolated role/profile configurations and sizes uniform in
[100000, 1000000] with boundaries; seams: `SessionTeams.compactWindowFor` and
`claudeSpawnLaunch`; snapshot `process.env` before/after; seed `0x4d494d4f`,
128 cases; each result equals the W table's independent resolution.

## Implementation notes (writer-owned local choices)

- The spawn reads R from `resolveClaudeProfileDetail`, the same resolution
  `resolveClaudeProfile` returns, so C is checked against the set the launch
  was filtered by; the refusal's branch label is `auto-compaction`.
- Flattening: a model's own window, else a re-homed key's inherited one,
  else its provider's.
- A file pairing `executable` with `autoCompactWindow` on one entry or
  provider is refused; a pairing assembled across files is reported and the
  window dropped (wrappers never compose either way).
- D1's explicit declaration is the profile's startup model or a catalog
  `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL` value ending in `[1m]`;
  inherited global env never counts.
- Role tokens match `^[1-9]\d*$` within range; unknown keys are dropped with
  a warning in `groupCatalog.ts`, known unlisted keys (bare or qualified)
  warn and stay.
- R1 is recorded as UNVERIFIED in `r1-runtime-smoke.md`.

## Production composition checkpoint

First path: a real manager start of a MiMo member with a role override,
asserting the package launch's `childEnv` and `settings.env` (L1), and the L6
refusal at respawn. A mutant that drops the `getCompactWindow` callback must
fail L1. Catalog and group parsing expand after it.

## Affected existing workflows

Profile resolution and credential pinning (`claudeProfiles.test.ts`,
`profileCatalog.test.ts`, `shippedCatalog.test.ts`), registered-name refusals
(`registeredNamesRetention.test.ts` and the manager refusal tests), effort
resolution, group parsing (`teamGroupFile.test.ts`, `teamGroupCatalog.test.ts`),
context mirroring, and the GLM/Kimi shipped windows. All stay green.

## Risks / Trade-offs

- Upstream docs may differ from the installed CLI → R1 records the CLI
  version, effective settings, report fields, reserve and routing; a 200K raw
  report fails it.
- Env-only enablement does not override an operator's global
  `autoCompactEnabled: false` → documented limitation, visible in R1.
- Larger windows can cost more → document the default and overrides.

## Migration Plan

Ship parser, launch, and the shipped MiMo entry together. Existing installs
inherit 300000 through the merge; role examples show overrides. Start a fresh
agent process to adopt new settings. Roll back by removing the fields and the
shipped tags with the code.

## Scope inventory (2026-10-26 text → this update)

| Item | Disposition |
|---|---|
| Spec scenarios (agent-teams, 14) | kept; `modelAutoCompactWindow` renamed to `profileAutoCompactWindow`; "Model-specific role preference wins" → "Profile-specific role preference wins" |
| claude-session-profiles "Replacement catalog (replace mode)" | folded into C5a (today's user-level replacement) |
| — "Merge-mode inheritance" | → "User-level catalog replaces the shipped preference" (C5a) and "Project overlay omits the window" (C5b) |
| Other claude-session-profiles scenarios (10) | kept |
| Tasks 1.1–4.2 | kept, retargeted (tasks.md); 1.1 drops C5c |
| D4 (relay landing order) | proposed removal |
| Oracles C5a, C5b, C5c | C5a, C5b re-derived over today's user-level/project tiers; C5c unreachable |

## Implementation contract

### Acceptance
- A1: The shipped MiMo profile declares `[1m]` on its startup model and every tier mapping and a 300000-token window; row C1 passes through `resolveClaudeProfile` and `claudeSpawnLaunch` with an isolated empty home.
- A2: Catalog `autoCompactWindow` parses, merges, re-homes, and refuses invalid or incompatible entries per rows C2–C4, C5a, C5b, L5.
- A3: Role `autoCompactWindow` and `profileAutoCompactWindow` parse with warnings and resolve per rows W1–W5, G1–G4, and V1.
- A4: A real manager start and respawn compose the selected window and cleared switches into both env layers and feed the tracker and start observation (L1–L4, M1), or refuse a registered collision before spawn (L6, L7).
- A5: R1 is recorded with its actual CLI version and fields, or explicitly as unverified when owner credentials or the baseline CLI are unavailable.
### Invariants
- I1: No launch mutates `process.env` or another session's launch (property P1, L3).
- I2: Composed keys are never added to the registered-name set, and a collision never reaches a child process (L6, L7).
- I3: Without a selected preference, launches are byte-identical to today's (W4, W5).
### Scope
- `src/server/chat/catalogParse.ts`
- `src/server/chat/catalogMerge.ts`
- `src/server/chat/profileCatalog.ts`
- `src/server/chat/ClaudeProfiles.ts`
- `src/server/chat/claudeCompaction.ts`
- `src/server/chat/provider/claudeRuntimeLaunch.ts`
- `src/server/chat/provider/claudeRuntime.ts`
- `src/server/chat/provider/claudeDriverTypes.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/team/groupFile.ts`
- `src/server/team/groupCatalog.ts`
- `src/server/team/sessionTeams.ts`
- `src/server/team/workspaceRead.ts`
- `src/shared/teamWorkspace.ts`
- `config/profiles.default.json`
- `docs/claude-session-profiles.md`
- `AGENTS.md`
- `src/server/__tests__/**`
- `openspec/changes/mimo-million-token-context/**`
### Verification
- V1: Tables W, C, G, L, M, V are committed verbatim as table-driven tests, L1 and L6 through the production manager, each named mutant shown failing.
- V2: Property P1 runs with seed `0x4d494d4f` and 128 cases.
- V3: Citation preflight, then `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, and `openspec validate mimo-million-token-context --strict` pass.
### Excluded
- X1: No `packages/agent-runtime` change and no package publication.
- X2: No relay install modes, retained layers, or trim; no action on held relay lineage.
- X3: No override of an operator's own global `autoCompactEnabled` setting.
- X4: No credentialed run without the owner; R1 is never waived or fabricated.
