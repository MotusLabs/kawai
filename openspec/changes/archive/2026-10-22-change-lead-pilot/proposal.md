# Proposal

## Why

Kawai's Team Lead currently owns both cross-change integration and the detailed decomposition, clarification, review routing, and correction loops of each change. Pilot delegated ownership of one complex change to determine whether focused context and local decisions reduce coordination waits and integration defects without adding disproportionate management cost.

## What Changes

- Add an opt-in `change-leads` role and a documented pilot protocol for one manually coordinated OpenSpec change at a time.
- Keep priorities, cross-change contracts, final integration and landing with the Team Lead; delegate in-scope interpretation, implementation subtasks, local assignments, review/fix coordination, and completeness evidence to the named Change Lead.
- Draw developers temporarily from existing shared groups, with one writer per worktree and one coordinator per task; retain independent, cross-model review and existing result acceptance rights.
- Represent the delegation in a Team Lead-created parent task and Change Lead-created subtasks. Record authoritative coordinator identities, contract boundaries, escalation triggers, and replacement/rollback instructions in task revisions and journals.
- Introduce explicit pilot reporting exceptions in developer and reviewer instructions, so routine reports reach the named Change Lead while ordinary work continues reporting to `lead`.
- Supply a bounded evaluation protocol covering comparable baseline work, correctness, elapsed time, named waits, coordination effort, and available token/cost evidence. Missing measurements remain unknown.
- Keep execution-owned changes outside the pilot and make withdrawal safe for in-flight assignments.

## Capabilities

### New Capabilities

- `change-coordination`: Optional delegated coordination of a complex change, including responsibility boundaries, evidence-based completion, recovery, and pilot evaluation.

### Modified Capabilities

None. Existing group, task, result, staffing, and execution contracts remain authoritative; this adds a repository role and operating protocol using those capabilities.

## Impact

- New `.kawai/groups/change-leads.md` and `docs/change-lead-pilot.md`; targeted updates to `lead.md`, all three developer role files, `reviewers.md`, and `docs/agent-collaboration.md`.
- Existing role parsing and task/mailbox services are reused. No API, database, UI, scheduler, quota, developer-pool, or task-ownership changes.
- Verification exercises parsed role rights and the existing task/assignment/review lifecycle in disposable fixtures; the live pilot is a later operational phase, not activation during artifact creation.
- The owner reports `parallel-suite` and `per-result-suite` implemented. The planning checkout still shows older runner/hook files; implementation must start from the authoritative integrated baseline and preserve those changes.
- Existing running agents keep their prompts until their next start. No automatic restart, staffing, mail dispatch, or configuration outside the repository occurs as part of installing the protocol.
