# AGENTS.md

- Bun 1.x, TypeScript 5.x, React 18, Hono, xterm.js, Zustand, Tailwind.

## Commands

```
bun run dev        # frontend + backend
bun run build      # production build
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit (incremental)
bun run test       # unit tests
bun run check      # lint + typecheck + tests, cached by content
```

`bun run test` gives each test file fresh temporary database, log, config, and
home directories (HOME points into the run root, so no test reads the real
~/.kawai, ~/.agentboard, or ~/.claude) and runs files with per-file isolation;
a bare `bun test` keeps the old shared-process mode. Non-tmux files run in one parallel `bun test`
step, and the real-tmux files serially after it (`--skip-real-tmux` skips
them). `--skip-slow` excludes the slow tier — every `*.integration.test.ts`
file plus the real-tmux files — and runs the rest; by default both tiers
run. After a full run the runner
records per-file durations to `<git-common-dir>/kawai-checks/timings.json`
(atomic rename) and keeps that run's snapshot beside it (newest five kept),
and the next full run reads that record with `--timings`,
so the slowest files start first; a missing or malformed record runs
unordered, and a filtered run (`bun run test <file…>` or `-t`) never
overwrites the record. The misplaced-file report judges each file by its
shortest duration across the kept snapshots, so one load-inflated run does
not name it. The default is 4 workers, overridable with `KAWAI_TEST_WORKERS` —
measured as the largest count whose peak process-tree memory stayed within
one serial run's, and capped at the cgroup CPU quota (`cpu.max`, else the
platform parallelism). `bun run test <file…>` runs just those test
files through the same machinery. The runner passes `--timeout=20000` to
every `bun test` child (per-file isolation pays cold-start costs the shared
process amortized); a bare `bun test` keeps Bun's 5 s default, and a later
`--timeout=<ms>` overrides the runner's value.

`bun run check` runs lint, typecheck, and the unit suite in order and records
a full pass under `<git-common-dir>/kawai-checks/`, keyed by a content hash of
the working tree (tracked and untracked non-ignored files) plus the Bun
version and platform. A run whose key already passed reports the recorded
pass — its time and worktree — and runs nothing; a failure or an interrupted
run records nothing; `--force` reruns everything. Records are shared by every
linked worktree and pruned after 14 days or 500 records. The pre-commit hook
(`scripts/pre-commit.ts`) is fast and never records a pass: a source commit
runs lint, typecheck, and the affected fast-tier tests (`scripts/affected-tests.ts`:
tests whose `@reads` header matches a changed path, plus Bun's `--changed`
import following over the working tree — unstaged edits outside the commit
can select tests too, and the hook names them); a docs-only commit runs lint,
typecheck, and the `@reads` matches; a change to the check machinery, a
manifest, the Bun pin, a hook, or a root config (the D2 escapes) runs
`bun run check`; a message-only amend runs lint and typecheck when the
index tree has a recorded pass, else `bun run check`. The pre-push hook
(`scripts/pre-push.ts`) is the certificate: each pushed commit needs a
recorded full pass for its tree, or HEAD at that commit and a clean working
tree, where it runs `bun run check` itself; otherwise the push is refused,
naming the commit and the command (deletions run nothing). `bun run check`
and the push refuse an index with skip-worktree or assume-unchanged entries,
which hide edits from the key. So commit freely,
and run `bun run check` on the clean committed tree before every result and
push. A test that reads a repository file at runtime (`AGENTS.md`, `docs/`,
`.kawai/`, …) declares it with a `// @reads: <globs>` header in its first 20
lines; `scripts/__tests__/readsGuard.test.ts` fails on an undeclared literal
path. `bun run test` stays the raw, uncached runner (typecheck keeps its
build info under `node_modules/`, never committed).

## How It Works

- Single tmux session (default: `agentboard`) with one window per project
- Backend discovers windows, streams terminal output via WebSocket
- Parses Claude/Codex JSONL logs from `~/.claude/projects/` and `~/.codex/sessions/` for status
- Status: unknown -> working -> waiting (derived from log events)
- Chat sessions (Claude Agent SDK and Codex app-server), teams and mailbox, routing and limits, tasks, strategy, plans (supervision, execution, workspace), outbound audit, process metrics, database safety, and the Team page are specified in `docs/architecture/`, one file per area (index: `docs/architecture/README.md`) and one bullet per subsystem. Before changing a subsystem, read its bullet: open the area's file or grep the directory (e.g. `grep -rn '^- Plan execution' docs/architecture/`).

## Structure

- src/server/     Hono backend, WebSocket, tmux/pty management, log parsing
  - `src/server/SessionManager.ts` - tmux window discovery, log parsing, status detection
  - `src/server/index.ts` - Hono routes, WebSocket handling
  - `src/server/chat/` - SDK driver, session lifecycle, transcript replay, subscriptions, and development fixture
  - `src/server/chat/wireTap.ts`, `ChatWireLog.ts`, `ChatWireLogs.ts` - always-on raw protocol capture for the chat debug view
  - `src/server/strategy/` - product strategy store, service, agent tools, and human-action connections; `impactSchema.ts`, `impactStore.ts`, `impactAssessment.ts`, `ImpactService.ts`, `impactRequestBody.ts`, `impactTools.ts` - strategy impact reviews (tables, derived assessment and gate, the owner's decisions, the assessment request, agent tools)
  - `src/server/plans/` - plan store, schema, hashing, approval preconditions, commands, service, lifecycle, agent tools, task link, and human-action connections
- src/client/     React frontend, xterm.js terminal, Zustand stores
  - `src/client/App.tsx` - main UI, keyboard shortcuts
  - `src/client/components/Terminal.tsx` - xterm.js wrapper
  - `src/client/components/chat/` - transcript, approvals, questions, and composer
  - `src/client/components/team/ProductStrategyView.tsx`, `StrategyDraftEditor.tsx`, `StrategyRevisionHistory.tsx` - strategy view (the Team page's Strategy tab), draft editor, and revision history
  - `src/client/components/team/StrategyImpactReview.tsx`, `ImpactDialogs.tsx`, `PlanImpactBadge.tsx` - the Strategy tab's impact sub-view, its Decide and Ask to assess dialogs, and the Plans view's impact badge
  - `src/client/components/team/TeamPlansView.tsx` (the Team page's Plans tab), `Plan*Section.tsx`, `PlanCommandDialog.tsx`, `PlanLifecycleControls.tsx`, `planLabels.ts`, `usePlanTargetsRefresh.ts` (the task form's plan pickers); `src/client/stores/teamPlanStore.ts` - Plans view and its store
  - `src/client/stores/chatStore.ts` - ordered transcript and pending requests
  - `src/client/components/chat/ChatDebugPanel.tsx`, `src/client/stores/chatDebugStore.ts` - protocol-frame panel behind the session menu's Debug toggle
- src/shared/     Shared types
  - `src/shared/chat.ts` - SDK-independent chat events and request contracts
  - `src/shared/productStrategy.ts` - SDK-independent strategy records, template content, claim kinds, and canonical hashing
  - `src/shared/strategyImpact.ts` - the pure impact model: dispositions, the gate, plan groups, review states, and their labels
  - `src/shared/plans.ts`, `src/shared/planMessages.ts` - SDK-independent plan records, content, derived states, diff summary, and the plan wire messages

- Data directory: `~/.agentboard/` contains `agentboard.db` (session data), `agentboard.log`, `chat-wire/` (per-chat-session raw protocol logs), `chat-workers/` (worker-outcome sidecars), `chat-tasks/` (background-task-outcome sidecars), and `backups/` (database snapshots), all beside the DB

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)
- Aim for 100% test coverage
- Recovery matrix (execution-safety-recovery D11/D17, contract E7): `docs/recovery-matrix.md` maps each fault to its mechanism, owning change, contract, and test (`` `file` › `exact title` ``) or `gap — <reason>`; `src/server/__tests__/recoveryMatrix.test.ts` checks every citation under `bun run test`. A change that adds a recovery mechanism (a startup reconciliation, an inspector, a replay key) or an exclusive slot adds its matrix row in the same change. Every exclusive-slot holder kind ships a liveness predicate and clears orphan holders at startup and whenever the slot is found taken — never leases, epochs, or fencing tokens; results keep their revision pin.
- Spec coverage (independent-verification D8): a test that covers a spec scenario names it with `// @covers: <capability> › <requirement> › <scenario>` directly above its `test`/`it` call (stacked annotations, blank lines, and comments in between are fine); `scripts/__tests__/specCoverageGuard.test.ts` fails the suite when an annotation names no scenario of the main specs or an active change's delta specs, is not directly above a test, or a spec name contains the ` › ` separator — fix the annotation in place, never the guard's grammar. When a change archives, every ADDED or MODIFIED scenario it leaves in the main specs, from an archive dated on or after `since` in `openspec/coverage.json` and not in that file's `exempt` list, needs a covering annotation; add them in the same change that archives it.

## UI Testing

- Verify UI changes in a real browser with Playwright (`bun run test:e2e`, `playwright.config.ts`). The e2e server serves `dist/client`, so run `bun run build` after any source edit.
