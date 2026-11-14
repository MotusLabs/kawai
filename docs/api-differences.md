# Agent-host API differences for the runtime 0.1.0 candidate

For Ruslan and SmartFactory's agent-host implementation. This is the local
candidate contract, not a publication or native-acceptance receipt.

| Host concern | Public runtime contract |
| --- | --- |
| Construction | Provider factories are inert; await `start()` separately from a turn. No Kawai server, tools, context or wire is required. |
| Submission | Await `send()` for `{ turnId, messageUuid, result }`; await `result` for the terminal value. Default active sends refuse busy; Claude queue and Codex steer are explicit. |
| Results | Outcome, text, model, nullable tokens, distinct tool/compaction counts and safe error; failures are terminal values. Cache creation means cache-write tokens. |
| Requests | Registered before `onRequest`; answer/deny inline. Default unanswered requests deny without UI/timers. Native toolCallId is correlation, requestId settles. |
| Interrupt | Cooperative receipt always says `processExit: false`; it cancels pending admission as well as active work. |
| Disposal | Await kill/shutdown from the outside supervisor. One terminal join covers owned processes and callbacks; callback-owned self-join refuses. Independently detached services require host containment. |
| Resume | Persist `onCheckpoint` before resolving, keep homes/transcripts, construct a new driver with saved identity. Invalid resume never becomes fresh. |
| Authority | Explicit complete childEnv/cwd/home/cache/temp per generation; no ambient credential merge. Permissions are separate and reapplied on resume. |
| Quota | Source/account scope explicit, missing data unknown; proxy quota is never borrowed from host login. Rate-wait end needs observed progress. |
| Events | Stable JSON IDs, per-stream sequence; reconstruction uses a new stream. Host owns replay/storage. |

Keep host stores, catalog selection, request deadlines, quota account claims,
mailbox and audit policies in agent-host. Start with the README recipes and
public `examples/headless.ts`; the package's existing detailed comparison is
`packages/agent-runtime/docs/api-differences.md` in the source repository.
No public runtime API was changed by this consumer/release-preparation batch.
