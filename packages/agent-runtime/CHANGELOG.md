# Changelog

All notable changes to `@motuslabs/agent-runtime`. Versions follow semver,
independently of Kawai's application versions. Any breaking change to the
documented API takes a new major version, even after 0.x.

## Unreleased (0.1.0)

- Public contract: `AgentDriver`, `TurnHandle`/`TurnResult`, `ResumeCheckpoint`,
  `ProcessExitReceipt`/`InterruptReceipt`, launch, permission, tool and
  callback options, core events, usage/quota/limit types and
  `AgentRuntimeError`.
- Claude driver checkpoints: `onCheckpoint` gets each new session id, and
  sends after it are acknowledged only once it persisted. A rejection
  refuses them, is reported and stops the driver. An interrupt refuses
  every send still waiting, also while idle, at once.
- Claude driver resume: a saved `resume` id continues the same conversation
  in a new driver or host process with the retained homes, and a respawn
  after an unexpected exit resumes the id reported last. A target the CLI
  refuses fails `start()` with category `resume` before any prompt, with no
  fresh conversation. A runtime that substitutes another conversation at the
  first init is refused the same way, and nothing of it is adopted.
- Claude driver process end: the results of the turns an unexpected exit
  ends are fixed before any callback, `onState('exited')` included, so a
  stop or interrupt called from one cannot replace them. A queued turn that
  never opened no longer gets a `turn_completed` event.
- Claude driver requests: each request is registered, with its abort
  listener, before its event and `onRequest` can answer it inline. The first
  terminal action wins; later, invalid and wrong-kind answers are refused.
  A signal already aborted on arrival is denied without publishing a
  request. Events, `onRequest` and `pendingRequests()` get separate copies,
  so a host mutation never changes what an allow runs or how an answer is
  checked.
- Internal Codex app-server transport (not exported): one owned
  `codex app-server` per transport with the launch's exact env and cwd,
  replies correlated by id and settled once, server requests and
  notifications routed to the supplied handlers, and a stop that joins the
  actual process group exit and every handler before it returns. A reply a
  handler produces after the stop began is never written.
- Codex driver (`./codex`): `createCodexDriver` over the owned app-server
  transport, with no SDK dependency. `start()` resolves only after a fresh
  thread's id persisted through `onCheckpoint`; a rejection fails it with
  `checkpoint`. A resume must return the requested thread, or `start()`
  fails with `resume` and nothing is adopted. Every resume and turn carries
  the session's own permissions. Turns bind to native turn ids only, `steer`
  joins the active turn, and the results of turns a stop or an unexpected
  exit ends are fixed before any callback runs. A turn is owned before
  `turn/start` is written, so a stop called from a callback meanwhile
  settles it, and a failed turn's result is fixed before its final limit
  event. A stop returns only after every generation's process group and
  host tool handler finished. The wire shapes are typechecked against the
  committed Codex 0.163.0 protocol types.
- Codex requests: approvals, user input and content-free elicitations reach
  `onRequest` with the Claude driver's ordering and first-answer rules. Form
  elicitations (`form`, `openai/form`, `openaiForm`) are one question
  answered with typed JSON, validated against the captured schema, nested
  objects and calendar dates included; a schema that can't be validated
  exactly is declined and reported once as `unsupported`.
- `hasCodexLogin(codexHome)` reports only whether an explicit Codex home
  holds a login; unauthorized protocol failures are category
  `authentication`, usage limits `quota`, rate limits `rate-limit`.
- Events, results and usage (`./usage`, no SDK dependency). Both drivers
  emit JSON-normalized events, numbered per stream; a resumed driver gets a
  new stream. Each `TurnResult` has the turn's own tokens, distinct tool and
  compaction counts, plus Claude's cost and model. Unknown values are
  `null`, and nothing is borrowed from another turn; a repeated or stale
  Codex token total adds nothing.
- Limit waits: a turn's first limit retry opens one `wait-start`. Its
  `wait-end` is `resumed` only at the turn's next observed progress, never
  from a reset time or a quota push; otherwise it is `cancelled` or
  `process-ended`.
- Quota reports are independent of turn state and name their `source` and
  `accountScope`: Claude pushes, Codex's one `account/rateLimits/read` plus
  pushes, an opt-in Claude host-login pull, and host-supplied reports via
  `hostQuotaReport`. An unavailable source reports nothing.
- Observers only observe. A throwing usage, event or result observer
  changes no result and skips no settlement, and the stop reports each
  throw once.
  A control called from a turn's own result publications or observations
  acts on that turn only. Its interrupt can't reach a queued successor or
  one sent from the same callback, which opens afterwards. A Codex wait
  resumes only on a token update that grew a counter.
- Not yet released: profile helpers arrive in later entries before 0.1.0 is
  published.
