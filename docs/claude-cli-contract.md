# Claude Code CLI contract for chat turns

The chat driver (the package core, `packages/agent-runtime/src/claude/session.ts`)
matches its turns to the Claude Code CLI's turns by identity, not by frame
order. The binding rules live in `packages/agent-runtime/src/claude/turnBinder.ts`. They rely on the contract below,
which holds for the floor version and every newer CLI.

## Floor

- Claude Code **2.1.289** or newer. This is the SDK-pinned baseline the
  manager checks before it creates a chat.
- Agent SDK **0.3.289**.

## Contract

1. **One result per CLI turn.** The CLI writes exactly one `result` for each
   turn, aborted or not, before the next turn's `system/init`.
2. **Results name their prompts.** The driver stamps every prompt with a
   fresh client `uuid`. Each prompted result echoes the uuids it consumed in
   `user_message_uuids` (or `user_message_uuid`). One result may name several
   prompts: a batch, or sends folded into the running turn. Results of turns
   the agent started on its own carry no uuid.
3. **A result ends only the turn its uuid names.**
   - A result naming a turn that already ended is dropped: an interrupted
     turn's late tail, or a duplicate.
   - A uuid the driver never sent is logged as `claude_unknown_result_uuid` and
     never ends a turn.
4. **Interrupts cancel queued prompts.** The CLI advertises
   `interrupt_cancel_queued_v1` in `system/init.capabilities`. When it does,
   every cooperative interrupt sends `cancel_queued`: Stop, archive and
   urgent mail. The package driver's kill and shutdown close the query and
   stop the process without an interrupt. The SDK's runtime `interrupt({ cancelQueued })` supports the
   option, but its type declaration omits it, so `interruptQuery` is the one
   typed call site. The receipt's `cancelled` list says which prompts will
   never run.
   Each process generation starts with the capability counted as present, so
   every interrupt sends `cancel_queued` (older CLIs ignore the field). A
   respawn starts again from present. Each later init that reports a
   `capabilities` array replaces the answer; an absent or non-array field
   keeps it. After an init without the capability, every interrupt is plain.
   Stop, archive and urgent mail then also log
   `interrupt-cancel-queued-unsupported` as `claude_cli_contract_violation`.
   Kill and shutdown never log it.
5. `command_lifecycle` frames are logged at debug level only. No rule reads
   them.

## Out of contract

A deviation is logged as `claude_cli_contract_violation`. It never strands a
turn. The logged reasons are:

- `init-before-owed-result`
- `result-before-owed-result`
- `prompted-result-without-uuid` (for example a startup-failure result)
- `interrupt-cancel-queued-unsupported`

At most one agent-started turn may close early, and only when an
out-of-contract init meets a uuid-less tail. Without the capability, the
interrupt is plain: queued prompts survive and run as later turns.

## Accepted limitation

`cancel_queued` also drops a background-task notification the CLI had
queued. That notification's agent-started turn then never runs. The task's
own `task_notification` frame still reaches the roster, so its outcome stays
visible.

## Recorded-frame test (CI)

- `src/server/__tests__/chatSessionDriver.interrupt.test.ts`, under
  "recorded CLI contract", replays masked frames from
  `src/server/__tests__/fixtures/cliContract/{prompt,task,cancel}.jsonl`.
- The same file holds synthetic out-of-contract orders, including those
  behind findings-970c7351 and findings-8388b668.
- `packages/agent-runtime/__tests__/claudeTurnBinder.test.ts` covers the
  binding rules alone, against the package's `src/claude/turnBinder.ts`.

## Live check when the floor rises

Run the probes by hand against the new floor binary. Each probe makes a real
haiku turn, which costs money, so they are never run in CI:

```
bun src/server/__tests__/fixtures/cliContract/probe.ts prompt <claude> /tmp/prompt.jsonl
bun src/server/__tests__/fixtures/cliContract/probe.ts task   <claude> /tmp/task.jsonl
bun src/server/__tests__/fixtures/cliContract/probe.ts cancel <claude> /tmp/cancel.jsonl
```

Each probe does the following:

- **prompt:** interrupts a prompted turn, then sends B.
- **task:** interrupts a turn the agent started after a background task, then
  sends B.
- **cancel:** queues B behind A, interrupts with `cancel_queued`, then sends C.

Compare each output with the committed fixture. All of these must hold:

- `init.capabilities` still lists `interrupt_cancel_queued_v1`.
- Every prompted `result` names its prompt (A, B, C).
- The aborted agent-started turn's result names none.
- Each aborted turn's single result comes before the next `system/init`.
- In **cancel**, the receipt lists B under `cancelled`, and no result names B.

If the outputs match, replace the fixtures with the new files: they are
already masked. If they differ, the contract changed. Stop and fix the
binding before raising the floor.
