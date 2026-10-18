# Proposal

## Why

Kawai can count tokens, task lead time and limit-related friction, but cannot explain how execution, review queues, quota waits and context management affect time to an accepted result. The owner needs actionable advice during an incident and regular improvements afterward, without waiting for a week of reports or requiring Prometheus.

## What Changes

- Record durable, attributed observations for Kawai-managed chats and team tasks only: turn/activity intervals, workflow stages and waits, context readings, compaction episodes, provider quota observations, dispatch alternatives, and recommendation decisions/outcomes. Reuse existing task, result, finding, assignment, usage and provenance records.
- Optimize task creation to first recorded result acceptance, with tokens per accepted result and review quality as guardrails. Include unfinished task age, coverage, acceptance actor/mechanism, and separate accumulated agent time from task elapsed time. Preserve existing first-done lead-time semantics under its existing metric names.
- Observe quota-serving providers eligible for configured team work even without a running chat. Record source, account/window/model scope, freshness and failures; unknown or unrelated host-login quota never becomes evidence of spare routed-provider capacity.
- Produce advisory recommendations at quota/context incidents and process bottlenecks, with frozen evidence, assumptions, expected time benefit, token/quality effects and uncertainty. Reassess them in one durable daily digest per team. Record the human's choice, actual intervention and later outcomes; recommendations never apply settings or dispatch work themselves.
- Extend the existing Metrics/report surfaces with recommendation histories, incident drill-down, and human-approved model/compaction experiments. Remove the report-window prohibition on early proposals while retaining permissions, frozen report snapshots, human-only proposal decisions and explicit implementation links.
- Export bounded aggregate counters, gauges and histograms through an optional Prometheus endpoint. SQLite is authoritative; collection, recommendations, reports and normal operation work without Prometheus. Durable export totals survive restart and detailed-data pruning.
- Deliver an independent foundation first: observation storage/reconciliation, managed-chat lifecycle/context recording, retention, and an optional Prometheus endpoint for supported sources. Then integrate provider quota and dispatch/context contracts for incident recommendations, followed by stage bottlenecks/daily reassessment and compaction comparisons. Missing integration sources remain explicit; completing the foundation does not complete the whole change.

Non-goals: external terminal sessions; automatic model switching, compaction, configuration edits or experiments; monetary budgets; causal claims from uncontrolled comparisons; deploying Prometheus/Grafana or sending reports outside Kawai.

## Capabilities

### New Capabilities

- `process-observations`: durable measurement history, task timing and attribution, quota/context observations, coverage, retention and incident evidence.
- `process-recommendations`: incident advice, versioned evidence and assessments, human decisions, intervention outcomes, experiments and daily digests within the existing Metrics surface.
- `prometheus-export`: optional aggregate export with bounded dimensions, durable accumulation and independence from core operation.

### Modified Capabilities

- `chat-usage-limits`: extend the provider-based live report contract with durable history and background quota collection for eligible providers without running agents. This delta is based on `providers-and-workers`, which must archive first.
- `chat-turn-usage`: retain usage for 90 days instead of 60; preserve task pinning and the documented main-loop/completed-turn scope. Introduced by `team-process-metrics`, which must archive before this change.
- `team-process-metrics`: add acceptance-time and stage/wait metrics, unfinished age and measurement coverage without redefining existing metrics. Introduced by `team-process-metrics`.
- `process-reports`: allow proposals in every supported window and reference immutable recommendation revisions; preserve existing proposal decision/link semantics. Introduced by `team-process-metrics`.

`team-process-metrics` is archived in the implementation worktree baseline, so `chat-turn-usage`, `team-process-metrics` and `process-reports` now exist in main specs. The provider-scoped usage delta still follows `providers-and-workers`. Prerequisites gate only their dependent integration tasks and archive order; they do not gate the independent foundation. Recheck landed contracts before integration instead of using stale completion counts from the initial audit.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts`, `ChatSessionManager.ts`, `contextUsage.ts`, `chatActivity.ts`, `chatTurnUsageStore.ts`, `src/server/metrics/`, task/result/assignment commit paths and routing diagnostics. Add SDK-free observation and recommendation services, quota collector adapters, daily scheduling and a Prometheus route in the existing HTTP server.
- Data: additive numbered migrations through `src/server/dbSafety/migrations.ts`; observation, recommendation, decision, intervention, experiment, digest and durable export records. Existing completed-turn usage retention becomes 90 days. No raw prompts, credentials or provider responses are copied into observations.
- Client/protocol: extend the Team Metrics tab and existing incident links, team-scoped subscriptions and human commands, plus additive read-only recommendation tools. No external messaging or new agent execution rights.
- Staging: the foundation records available source facts under their original identity and coverage. A legacy profile report is not an account-level capacity fact. Provider-aware collection, worker eligibility, canonical incident linkage and their metric families stay tracked until the actual prerequisite contracts are available; the final behavior and acceptance criteria remain unchanged.
- Coordination: reuse `providers-and-workers` account/model identities and `dispatch-worker-choice` candidate constraints; consume `chat-context-exhaustion` incident identities and `plan-supervision` named waits/alerts; recognize `revision-control` holds/pauses and `plan-execution`/`integration-candidates` acceptance mechanisms. Keep `session-targeted-task-handoffs` result linkage. Align optional Codex adapters with `codex-chat-sessions`' provider-neutral driver. New settings use `KAWAI_*` names and the existing resolved database path.
- Planning assumptions: 90-day detailed history; daily digest at 09:00 UTC by default with a per-team time zone/time override; ten-minute eligible-provider polling and freshness boundary; no waiting for a minimum sample to issue explicitly provisional incident advice. These defaults are configurable or revisable in implementation review, not claims about current behavior.
