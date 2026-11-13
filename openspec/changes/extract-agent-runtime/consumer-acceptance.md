# Batch C consumer acceptance

Task task-dcd0c718-d43f-4c62-9877-aa2b0f872a6a, contract r4#c163746c4303.
Base: 3093157cc87780925f366963a4c95a6b9382c864. One writer in the consumer
worktree; runtime src/API, shared design/tasks and B evidence are untouched.

This record describes local candidate evidence and its limits. Exact committed-head
validation receipts and the cross-model review belong to the task result.
Local packed consumers passed on Bun 1.3.0 and pinned 1.4.3 (9 tests each).
The new finally and release-check guard removals failed their intended assertions;
source was restored byte-for-byte. No accepted core controls were replayed.

| Task row / contract | Local observable oracle |
| --- | --- |
| 7.1 / A2 | Versioned packed empty stub, eight root aliases; clean minimum/current Bun installs and missing-override native-content control |
| 7.2 / A3 | Actual tar entries, ESM/declaration imports, no SDK Codex and separate configured Claude packed consumers; repository/native-content negatives |
| 7.3 / A4 | Public headless supervisor exercised unchanged with both controlled providers, requests, interrupt, awaited owned stop and saved-identity reconstruction |
| 8.1 / A6 | Exact tag/version/changelog/check and owner/native pins; local decision negatives plus parsed workflow trust/permissions checks |
| 8.2 / A5 | Complete README and copy-tested snippets; owner-visible docs/api-differences.md |
| batch / A7-A8 | Original accepted regressions, dist-free typechecks/builds, affected isolated fixture, clean exact-head full-properties/no-retry check; one cross-model review |
| sweep / A10-A11 | Whole sweep7553f8ac consumed; Lead R3 routing lifted the hold; outside-finally ownership and raw-failure witness passed |

The R4/A12 reader expectation preserves the three existing README consumers and
adds the new real README reader to the exact sorted selection. No selector or
runner logic changed.

## Deferred acceptance

- 7.4 / D08: real authorized Claude/Codex lifecycle and permission receipts.
- 8.3: final assembled validation/review/CI across batches.
- 8.4 / D06-D07: owner publication, immutable registry versions/digests,
  package access settings, local read-token and SmartFactory GITHUB_TOKEN
  installation receipts. Local packs and workflow tests do not substitute.
- Node 22: optional, unverified.

The workflow is preparation only. The owner-protected release environment
and exact accepted/native/authorized commit pins must remain unset until
the corresponding real receipts and authorization exist. No workflow was
dispatched and no package was published by this batch.

## Cleanup checklist

The one sweep's six checks apply to the new supervisor and consumer fixture.
The accepted runtime/shared helper remains unchanged; this table does not
claim a new universal exceptional-cleanup proof for it.

| Path | Admission | Work/callback join | Concurrent/idempotent close | Callback-owned reentry | Disposal after join | Error retention |
| --- | --- | --- | --- | --- | --- | --- |
| `examples/headless.ts` | P: closes output admission; delegates driver terminal refusal | P: outside finally joins every driver, then every admitted output promise | P: delegates memoized terminal stop | NA: callback cannot access this outside cleanup owner | P: owned exits asserted; root removal is caller-owned | P: primary plus four sync/async observer failures retained by exact raw identity/order/count |
| `helpers/consumerInstall.ts` | P: closing flag precedes shared once body; fresh/pack refuse | P: synchronous subprocess calls joined actual exit and stdout/stderr | P: accepted ownedOnce; overlap/repeat witness | NA: no callback-owned cleanup route | P: project removal follows synchronous host joins | P: cleanup rejects unchanged; no error is discarded |
| Existing factory-only recipes | NA: return inert drivers | NA: caller owns driver | NA: driver contract | NA: caller must stop outside callbacks | NA: caller responsibility | P: explicit finally ownership comment |
| Compile-only contract consumer | P: driver contract | P: finally awaits shutdown after start/send errors | P: driver contract | NA: no cleanup callback route | NA: owns no project removal | P: aggregates primary and stop failure; compile-only, not provider evidence |

Finite new witnesses: `packages/agent-runtime/__tests__/consumerInstall.test.ts` › `consumer fixture closes admission, shares idempotent cleanup and removes roots after synchronous commands finish`;
`packages/agent-runtime/__tests__/consumerInstall.test.ts` › `A11: primary output and observer cleanup failures retain exact raw identity while owned process exits before removal`.
Normal packed lifecycle test additionally checks both providers' owned PIDs
are gone and their stop receipts report actual group clearance.
