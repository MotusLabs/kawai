# Architecture

Feature-by-feature behavior of Kawai, one bullet per subsystem, moved out of `AGENTS.md` so agents load it on demand. Open the file for the area you are changing, or grep the directory by feature name (`grep -rn '^- Plan execution' docs/architecture/`), and read only the matching bullet.

- [`chat.md`](chat.md) — Claude and Codex chat sessions: drivers, profiles, slash commands, approval policy, question auto-answer, activity, background tasks, usage bar, notices, header, transcript, history window, drafts, search, archive, navigator.
- [`outbound.md`](outbound.md) — The agent security note, outbound destinations, the outbound audit hooks and classifier, and the Team page Audit tab.
- [`mailbox.md`](mailbox.md) — Teams, the kawai-team MCP server, threads, mailbox management, waiting reasons, delivery receipts, and message events.
- [`routing.md`](routing.md) — Profile routing, routing rules, group-mail dispatch, worker choice, rate/credit limits and cooldowns, context exhaustion.
- [`tasks.md`](tasks.md) — Group settings, task records, rights and tools, task mail, staffing, member release, assignment and dispatch, revisions, results, checks, coverage, task controls, Task UI, workflow stage.
- [`team-page.md`](team-page.md) — Messages view, the Team page shell and routing, the workspace read model, attention queue and morning summary, Members tab.
- [`strategy.md`](strategy.md) — Strategy records, evidence, agent tools, approval, the Strategy UI, and strategy impact reviews.
- [`plans.md`](plans.md) — Plan records and content, approval and lifecycle, validation, agent plan and validation tools, the task link, plan protocol, and the Plans view.
- [`plan-supervision.md`](plan-supervision.md) — Supervision records, decision cards, plan usage, the supervision detail, and the stall monitor.
- [`plan-execution.md`](plan-execution.md) — Execution, integration landing, promotion, holds, and pause.
- [`plan-workspace.md`](plan-workspace.md) — Workspace records, the read-only workspace view, and the repository conversation.
- [`metrics.md`](metrics.md) — Agent-start provenance, per-turn usage, process observability, process metrics, reports and proposals.
- [`database.md`](database.md) — Migrations, startup refusal, and backups.
