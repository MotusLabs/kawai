# Stop receipts

`kill()` and `shutdown()` resolve with a `ProcessExitReceipt` only after the
driver's owned agent processes have **actually exited** and its owned
JavaScript work has joined. This page says what a receipt proves and what it
does not.

## What a receipt proves

Each owned process generation is spawned by the package's own spawner
(`src/process/ownedProcess.ts`): with exactly the caller's launch environment
and cwd, as the leader of its own POSIX process group. Stopping a generation:

1. Sends `SIGTERM` to the group, unless the leader has already exited.
2. Waits up to `graceMs` (default 2 s) for the leader's actual `exit`. If it is
   still alive, sends `SIGKILL` to the group and records `escalated: true`.
3. Waits up to `killMs` (default 5 s) more. If the leader still has not
   exited, the stop **fails** with an `AgentRuntimeError` of category `stop`.
   There is no successful receipt.
4. After the leader exits, checks the group for live members (helpers that
   inherited the leader's pipes, for example), signals them the same way, and
   fails the same way if any survive `SIGKILL`. Zombies count as exited.

Each generation's fact (`ProcessExitFact`) records:
- `pid`, and the leader's own `code` and `signal`;
- `escalated`: whether termination went past the first signal;
- `groupCleared`: whether the group was confirmed to have no live members.

A generation whose spawn never created a process is reported as
`never-started`.

None of these count as exit: a signal being delivered, the SDK's iterator or
stream ending, an SDK result, an interrupt acknowledgement, `child.killed`,
or a timer running out. A stop that cannot establish actual exit fails
explicitly.

Stop is memoized: concurrent and later callers of `kill()`/`shutdown()` get
the first stop's outcome, success or failure.

## What a receipt does not cover

The receipt's `scope` is `agent-processes`: the runtime's own processes and
their process groups. It does not cover:
- processes that left the group: daemons that call `setsid`/`setpgid`, or
  services the agent started through an external manager;
- processes the caller started itself;
- other hosts, containers or remote sessions the agent reached.

Before reusing a workspace or its resources, contain these with the host's
own mechanism, for example a pod, a cgroup or a container that is torn down.

## Platform support

The group probe reads `/proc` on Linux and treats zombies as exited. Other
POSIX hosts fall back to `kill(-pgid, 0)`, which cannot tell a zombie from a
live member. A non-reaping init can therefore make a stop fail there rather
than succeed falsely. Windows has no process groups here, so only the leader
is tracked and `groupCleared` is `false`.

Tested: Linux containers with Bun 1.4.3. Every other platform is untested and
listed here once it has been.

## Environment

The spawner passes the launch's `childEnv` exactly. It merges nothing from
`process.env` and ignores the environment the Claude SDK proposes in its
`SpawnOptions`. If the CLI needs a protocol variable (the SDK sets
`CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_AGENT_SDK_VERSION` and removes
`NODE_OPTIONS`), the profile helper must put it in the returned map.
