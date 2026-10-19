# Codex smoke transcript fixtures

`smoke-transcript.jsonl` is the recorded JSON-RPC conversation of
`scripts/codex-smoke.ts` against the installed codex-cli **0.163.0** (one
`codex app-server` child per process, stdio newline-delimited JSON-RPC). Each
record is `{"dir": "out" | "in", "line": "<one JSON-RPC message>"}` in
chronological order.

Phases covered:

- run 1, fresh thread: `initialize` (experimentalApi), `thread/start` with the
  D5 sandbox and the `kawai-team` dynamic-tool namespace, a dynamic tool call
  (`item/tool/call`, answered without any approval), the `git commit` approval
  round-trip (`item/commandExecution/requestApproval`, accepted), and a
  declined out-of-sandbox write.
- run 2, `thread/resume` of the same thread in a fresh process: an async
  question (an `agentMessage` item with `questions` set and
  `delivery: "async"`, answered by `turn/start` input added to the active
  turn), and `turn/interrupt` completing as `interrupted`.
- run 3, same thread again: the sandbox-failed-to-initialize escalation
  (bwrap cannot create user namespaces on the smoke host) and a localhost
  bind that succeeds once accepted, plus `account/rateLimits/read`.

Scrubbing is applied at recording time by `scripts/codex-smoke.ts`
(`scrubSmokeValue`), and the fixture hygiene test re-checks the committed
file against the same rules: the home directory → `/home/smoke/`, every
per-run scratch workspace (`/tmp/kawai-codex-smoke-<random>`) →
`/tmp/kawai-codex-smoke-fixture` so the resumed thread's world stays
coherent, and identifying keys → fixed placeholders (`serverName` →
`smoke-host`; `installationId`, `accountId`, `userId`, `orgId` → placeholder
UUIDs; `email` → `user@example.internal`). Tool output the scrub cannot
model needs a hand pass before committing: this fixture replaced one real
external hostname (a public docs-shortener link inside bubblewrap's error
text) with the reserved `https://example.internal/bubblewrap`. Thread,
turn, and item ids are Codex's own opaque UUIDs; no account, token, or
email value survives the scrub.
