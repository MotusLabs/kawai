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
  refuses them, is reported and stops the driver. The Codex driver's
  checkpoints are not implemented yet.
- Not yet released: the Claude and Codex drivers, profile helpers and usage
  parsers arrive in later entries before 0.1.0 is published.
