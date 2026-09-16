## Context

See proposal.md - Why for the motivation. The constraints that shape the approach:

**The false idle.** `inferSessionStatus` (`src/server/statusInference.ts:196`) returns
`waiting` whenever `prev === undefined`, which is always true for a window's first
sample. `session-create` calls `refreshSessions()` immediately after `createWindow()`
returns (`src/server/index.ts:2650`), so `reconcilePendingAutoStart` fires within a few
hundred milliseconds of tmux spawning the agent.

**Measured behaviour.** Four tmux probes against `claude` 2.1.261, launched the way
`SessionManager.createWindow` launches it (`-e CLAUDE_CODE_NO_FLICKER=1`, command run
through `sh -c`):

| Probe | Setup | Result |
|---|---|---|
| A | `send-keys -l` + `Enter` immediately after spawn | Text reaches the composer, Enter is swallowed, nothing submits |
| B | same keystrokes after the TUI is up | Submits correctly, back to back, no inter-key delay |
| C | `claude "/status"` as an argv positional | Slash command executes in the interactive session |
| D | `claude "/status"` in a fresh, untrusted directory | Trust dialog first; after approval the prompt still runs |

Probe B rules out keystroke pacing as the problem. Probe D rules out a readiness
heuristic as the fix: a fresh worktree opens on a trust dialog whose default option is
**No, exit**, and none of the `PERMISSION_PATTERNS` in `statusInference.ts` match its
wording, so the pane reports `waiting` and an injected Enter would exit the session.
Codex's unauthenticated onboarding screen has the same shape.

**Agent type today.** `inferAgentType` matches exact basenames, so wrappers like
`claude-glm` resolve to `undefined`. `hydrateSessionsWithAgentSessions`
(`src/server/index.ts:1072`) then backfills from the log family — `session.agentType ??
agentSession.agentType` — so wrappers self-correct once their JSONL is discovered.
That backfill is unavailable at creation time, which is the only moment auto-start needs
an answer.

## Goals / Non-Goals

**Goals:**
- Deliver the first prompt through a mechanism with no timing dependency at all.
- Keep the agent choice visible and overridable at the moment of session creation.
- Remove more machinery than is added.

**Non-Goals:**
- Fixing the first-sample `waiting` inaccuracy in `statusInference.ts`. It stops being
  load-bearing here, but it still mislabels new windows as idle for the sidebar, and it
  still reports a trust dialog as idle. Separate change.
- Teaching `inferAgentType` about wrapper names (see Decision 2).
- Arbitrary user-authored first prompts. The dropdown's shape allows a `Custom...`
  option later; this change does not add one.

## Decisions

### 1. Argv positional over any timed injection

Both CLIs accept an interactive first prompt as a positional (`claude [options] [prompt]`,
`codex [OPTIONS] [PROMPT]`), and the agent holds it until after trust and login are
resolved (probe D). The prompt is part of the process's own argv, so there is nothing to
schedule, nothing to retry, and no window in which a client reload loses it — which also
retires the reason `PendingAutoStartStore` held state server-side.

Alternatives: a fixed delay before injecting (guesses at TUI boot time, still loses to
the trust dialog); readiness detection from pane content (needs to recognise the trust
dialog, the theme picker, and the login flow, and each agent release can add another);
per-keystroke pacing (probe B shows pacing is not the variable, and typing `/opsx:apply`
character by character opens the slash-command autocomplete, where Enter selects a menu
entry instead of submitting).

### 2. The `claude*` / `codex*` prefix rule defaults the dropdown; `inferAgentType` stays exact-match

Command-based detection outranks the log-derived type (`index.ts:1072`), and it feeds
`getResumeCommandTemplate` (`index.ts:3558`), whose fall-through branch is Codex. A
wrong prefix guess inside `inferAgentType` would therefore be silent, sticky, and would
suppress the accurate log-family value that today corrects wrappers automatically. The
same guess used as a dropdown default is visible before the session exists and costs one
click to correct.

Match on the resolved agent token, not the raw string: extract the token walk already in
`inferAgentType` (`agentDetection.ts:109-138`, which skips `npx`/`bunx`/`env`,
`VAR=value` assignments, and flags, then takes the basename) as `resolveAgentToken`, and
have both the exact matcher and the prefix rule consume it. A naive
`command.startsWith('claude')` would miss `env FOO=1 npx claude-glm --yolo`.

### 3. The dropdown is always offered, defaulting to Nothing

Hiding it for unrecognised commands would make a wrapper named without a `claude`/`codex`
prefix permanently ineligible even when the user knows it takes Claude arguments.
Offering it always, defaulted to Nothing, keeps the unrecognised case inert while leaving
the override available. Option labels carry the literal prompt text
(`Claude - /opsx:apply <change>`) so a mis-mapped command is visible before launch rather
than after a failed session.

Default precedence: the selected preset's declared `agentType` (an explicit user
declaration, already stored in `CommandPreset`), else the prefix rule, else Nothing. The
default recomputes as the command changes until the user picks a value explicitly, after
which their choice sticks — so editing a command away from its preset re-derives by
prefix instead of silently losing the option.

### 4. The server composes the command from `{change, agent}`

`session-create` carries the selected agent alongside the change name rather than raw
prompt text, keeping `isValidChangeName` validation and the `APPLY_COMMANDS` map in one
place. The server quotes the prompt with the existing `shellQuote` helper and appends it
to the command before `createWindow`. Single-quoting is mandatory, not cosmetic: the
Codex form `$openspec-apply-change <change>` is passed to tmux as one string and run
through `sh -c`, where double quotes would expand `$openspec` to nothing.

Remote creation needs no special handling — `handleRemoteCreate` already forwards
`command` — which is why the dropdown is offered on remote hosts where the checkbox was
not.

### 5. `buildResumeCommand` must drop the apply prompt

`launchCommand` is captured from the tmux pane start command (`logPoller.ts:481` and
`index.ts:3413`), so the composed command becomes the stored launch command.
`buildResumeCommand` (`index.ts:3577`) then strips only the executable and known resume
flags and carries everything else into the resume command, which would produce
`claude '/opsx:apply <change>' --resume <id>` and **re-run the apply prompt on every
wake**.

Strip the apply prompt by pattern in the same extraction chain that already removes
`--resume <id>`, `resume <id>`, and `--session <path>`. The composed prompts are
regular — a quoted `/opsx:apply <kebab-change>` or `$openspec-apply-change
<kebab-change>`, always last — so a targeted pattern has effectively no false-positive
surface and matches the function's existing idiom.

Alternative: record the base command separately at creation so the prompt never reaches
`launchCommand`. Rejected as heavier — `launchCommand` is written by the log poller when
the agent session record is created, well after `session-create` returns, so it would
need a new server-held window-to-command map, reintroducing the kind of ephemeral state
this change removes. Rejected also because a generic "keep only flags" rewrite cannot
know each flag's arity.

## Risks / Trade-offs

- **The wrapper does not forward `"$@"` to the underlying CLI** → the prompt is dropped
  or errors the launch. Not detectable from Agentboard. The literal prompt in the
  dropdown label makes the attempt visible, and Nothing remains selectable.
- **The wrapper is a shell alias or function rather than a script on `PATH`** → tmux's
  `sh -c` cannot resolve it, and the session already fails to start today. Unchanged by
  this design, but worth stating: the prefix rule will still offer the option.
- **The mapped apply command does not exist in the user's environment** → the agent
  starts and answers `Unknown command`. Observed with `/opsx:apply` in a workspace whose
  skills are `openspec-apply-change` with no `opsx` plugin installed. The change does not
  alter the mapping, but the dropdown label now surfaces the mismatch pre-launch.
- **A wrong prefix guess preselects the wrong agent** → visible in the form, one click to
  correct, and it cannot leak into icons, resume templates, or status because the rule
  lives only in the dropdown default.
- **The session's `command` now contains the prompt** → it appears anywhere the raw start
  command is surfaced. `inferAgentType` is unaffected (it takes the first meaningful
  token) and resume is handled by Decision 5, but any future consumer of
  `session.command` inherits this.

## Migration Plan

No data migration. `PendingAutoStartStore` holds only in-memory state, so a deploy
mid-session loses nothing that outlives a restart today. Sessions created before the
deploy are unaffected — they carry no prompt in their launch command, and the stripping
in Decision 5 is a no-op for them. Rollback is a straight revert.

## Open Questions

- Does Codex expand `$openspec-apply-change` as a skill reference when it arrives as an
  argv positional rather than typed into the composer? **Answered during task 6.1:
  yes.** Verified on codex 0.153.4 authenticated via ChatGPT. A probe skill whose body
  alone held a unique token was launched as `codex '$ab-probe hello-world'`; Codex held
  the positional through the directory-trust dialog, then expanded the `$`-skill
  reference and replied with the token without any tool calls — the body can only have
  been injected by expansion. Caveat: `$openspec-apply-change` resolves only where that
  skill is installed for Codex (`~/.codex/skills`); on a machine without it the prompt
  still delivers verbatim and the model falls back to searching for the skill — the
  same environment-mapping mismatch as `/opsx:apply` for Claude (see Risks). The
  `APPLY_COMMANDS` Codex entry stays as written.
- Should the `opsx` mapping be revisited? `/opsx:apply` resolved to `Unknown command` in
  this workspace. Out of scope here — this change carries the existing mapping forward
  unaltered — but it determines whether correct delivery produces a working session.
