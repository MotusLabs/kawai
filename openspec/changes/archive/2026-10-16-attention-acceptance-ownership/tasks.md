## 1. Projection

- [x] 1.1 `TeamTaskSummary.outstandingResult` gains `reviewVerdict: 'pass' | 'fail' | null`.
  - It holds the verdict of the newest findings bound to that result: by `created_at`, then rowid.
  - It is set in `TaskStore.summary`, and is null when the result has no findings.
- [x] 1.2 `teamTaskStage`: after the handoff rungs, an unaccepted result whose `reviewVerdict` is `fail` is `fixes-requested`. Update the ladder comment.
- [x] 1.3 `taskNextAction`: a failing unaccepted result reads **Wait for fixes**.
- [x] 1.4 Check the task list's awaiting-acceptance filter. It must still match only Awaiting acceptance rows, so a failing result leaves it.

## 2. Attention items

- [x] 2.1 Add the `fixes-requested` attention kind to `src/shared/teamWorkspace.ts`, and give it a client label beside **Pending acceptance**.
- [x] 2.2 `workspaceRead`: a failing outstanding result yields exactly one agent-owned `fixes-requested` item, and no `pending-acceptance` item. The item has:
  - identity `fixes-requested:<resultId>`;
  - owner: the result's submitter;
  - next action **Wait for fixes**;
  - link: the task.
- [x] 2.3 Otherwise, a task created by a live agent session yields an agent-owned `pending-acceptance` item:
  - "live" means present in the session records and not archived;
  - owner: that session;
  - cause: "Result submitted by <submitter> awaits acceptance by <creator>";
  - a human-created task, or one whose creator is archived or killed, stays human-required, as today.

## 3. Tests and docs

- [x] 3.1 Unit tests:
  - the stage ladder: fail gives Fixes requested; pass and no findings give Awaiting acceptance; an outstanding handoff still wins;
  - `reviewVerdict` comes from the newest findings;
  - each acceptance owner case: human creator, live agent creator, archived creator, killed creator;
  - the failing case, including the task row's `requiresHuman` and the awaiting-human filter;
  - that agent-owned items raise no toast;
  - the client label.
- [x] 3.2 AGENTS.md: update the Attention queue and Task workflow stage bullets.
- [x] 3.3 `bun run lint && bun run typecheck && bun run test` pass.
