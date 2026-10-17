# Claude Code CLI contract for chat turns

The chat driver (`src/server/chat/ChatSessionDriver.ts`) matches its turns to
the Claude Code CLI's turns by identity, not by frame order. The binding rules
live in `src/server/chat/cliTurnBinding.ts`. They rely on the contract below,
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
   - A uuid the driver never sent is logged as `chat_unknown_result_uuid` and
     never ends a turn.
4. **Interrupts cancel queued prompts.** The CLI advertises
   `interrupt_cancel_queued_v1` in `system/init.capabilities`. When it does,
   every driver interrupt sends `cancel_queued`: Stop, archive, kill, and
   urgent mail. The SDK's runtime `interrupt({ cancelQueued })` supports the
   option, but its type declaration omits it, so `interruptQuery` is the one
   typed call site. The receipt's `cancelled` list says which prompts will
   never run.
   Until the driver's first `system/init`, the capability counts as present,
   so every interrupt sends `cancel_queued` (older CLIs ignore the field).
   Each later init that reports `capabilities` replaces the answer, including
   the init after a respawn. After an init without the capability, every
   interrupt is plain. Stop, archive, and urgent mail also log
   `chat_cli_contract_violation` with `interrupt-cancel-queued-unsupported`;
   kill and shutdown do not.
5. `command_lifecycle` frames are logged at debug level only. No rule reads
   them.

## Out of contract

A deviation is logged as `chat_cli_contract_violation`. It never strands a
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
- `src/server/__tests__/cliTurnBinding.test.ts` covers the binding rules
  alone.

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
