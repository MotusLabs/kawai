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
  every send still waiting, also while idle, at once. The Codex driver's
  checkpoints are not implemented yet.
- Claude driver resume: a saved `resume` id continues the same conversation
  in a new driver or host process with the retained homes, and a respawn
  after an unexpected exit resumes the id reported last. A target the CLI
  refuses fails `start()` with category `resume` before any prompt, with no
  fresh conversation. A runtime that substitutes another conversation at the
  first init is refused the same way, and nothing of it is adopted. The
  Codex driver's resume is not implemented yet.
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
  checked. Codex input and elicitation requests are not implemented yet.
- Not yet released: the Claude and Codex drivers, profile helpers and usage
  parsers arrive in later entries before 0.1.0 is published.
