# @motuslabs/agent-runtime

Headless Claude and Codex agent drivers, extracted from Kawai: explicit
launch authority, observable requests and results, an owned process stop and
resumable sessions. Kawai and headless Bun daemons use the same
implementation.

**Status: unreleased, under construction.** The public contract is frozen
(`src/contract.ts`, `src/options.ts`, `src/events.ts`). The Claude driver
has moved (`./claude`); the Codex driver has not yet. See `docs/api-differences.md` for how the contract differs from
Kawai's in-tree driver interface, and `examples/contract-consumer.ts` for a
type-checked headless consumer.

Requirements: Bun >= 1.3.0, ESM. The Claude Agent SDK is an optional peer
dependency (only Claude drivers need it); neither CLI is bundled or
installed by this package.

The full consumer documentation (entry points, seams, callbacks, permissions,
environment helpers, stop-receipt scope, resume and installation from GitHub
Packages) lands with the 0.1.0 release.

## Child environments (`@motuslabs/agent-runtime/profiles`)

The runtime never reads `process.env` or a home directory to find
credentials. Every agent process receives exactly the `childEnv` you pass.
These pure helpers build that map from a base you approve (PATH, LANG and
similar) plus the provider values you select:

- They remove every Claude/Anthropic and Codex authority variable from the
  base, along with any names you list in `withheld`.
- They blank the alternatives to the selected credential.
- They pin the proxy and TLS variables to your base's values, or to empty.

Each Claude helper also returns non-secret `settings` for the SDK's
`settings` option. They reach the CLI as `--settings` JSON, so they never
contain a token or a header value.

```ts
import { anthropicOAuthProfile, claudeProxyProfile, codexProfile } from '@motuslabs/agent-runtime/profiles'

const base = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }

// Anthropic subscription login (OAuth token from `claude setup-token`).
const oauth = anthropicOAuthProfile({ base, oauthToken: myOAuthToken })

// An Anthropic-compatible proxy, Z.AI style. The key travels in a custom
// header, and the auth token is the placeholder the proxy expects.
const proxy = claudeProxyProfile({
  base,
  baseUrl: 'https://api.z.ai/api/anthropic',
  authToken: 'placeholder',
  customHeaders: `X-Api-Key: ${zaiKey}`,
})

// Codex logged in through its own home (`CODEX_HOME=… codex login` beforehand).
const codex = codexProfile({ base, codexHome: '/srv/agents/session-1/codex-home' })

// Then: launch: { cwd, childEnv: proxy.childEnv, homeDir, cacheDir, tempDir }
// and, for Claude, the profile's `settings`.
```

Missing or malformed inputs throw an `AgentRuntimeError` with category
`configuration` before anything spawns. If `withheld` lists a name the
profile itself has to set, such as `CODEX_HOME` for Codex, the helper
refuses rather than choosing between leaking it and breaking the profile.
The Claude helpers also set `CLAUDE_CODE_ENTRYPOINT` and
`CLAUDE_AGENT_SDK_VERSION`. The SDK normally adds these itself, but the
owned spawner ignores the SDK's proposed environment.

## Claude permissions

`permissions` holds three separate settings: the permission `mode`,
`disallowedTools`, and `enabledTools` (a list, or `'all'`). They are enforced
by a deny-only `PreToolUse` policy hook that the runtime installs first on
every session and every respawn:

- A disallowed tool is denied in every mode, bypass included.
- With an `enabledTools` list, every unlisted tool is denied without
  prompting, custom and MCP tools included.
- A permitted tool gets no decision from the hook, never `allow`. The CLI's
  own permission checks still apply in the non-bypass modes.

`allowedTools` and `canUseTool` are not used for enforcement. Hooks run
before allow rules, and a deny from any hook wins, so neither, nor any
observation hook of yours, can re-grant a denied tool. Entries must be exact
tool names. A permission rule such as `Bash(git:*)` or a wildcard can't be
enforced by name, so the session refuses to construct, with category
`configuration`. Omitting `permissions` means no policy. A supplied value
that is not a valid policy, `null` included, is refused the same way.

`RESTRICTED_CLAUDE_PERMISSIONS` is the restricted v1 profile:
`bypassPermissions`, the read set `Read`/`Glob`/`Grep`, and denials of
`AskUserQuestion`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and **Bash
entirely**. v1 ships no Bash command parser or allow-list. Either Bash is
denied entirely, or it is allowed with no command restrictions.

Limitation: the hook-before-disallowed ordering and deny-wins resolution are
tested against the fake CLI, which follows Anthropic's documented order. The
real CLI is checked only at task 7.4, which needs a model turn.

## Codex permissions

`CodexPermissions` gives the approval policy (`never` for headless use), the
sandbox (`workspace-write`, `read-only` or `none`), network access, extra
writable roots, and whether user input and elicitation are enabled. The same
value is turned into exact protocol fields for `thread/start`,
`thread/resume` and every `turn/start`:

- **Approvals.** `approvalsReviewer` is always `user`.
- **Caller fields.** Caller fields can't widen the policy. Policy fields win,
  and a named `permissions` profile is dropped.
- **Resume.** A resumed thread never inherits a broader stored policy.
- **Sandbox `none`.** It maps to the protocol's `danger-full-access`. It is
  never silently replaced by `workspace-write`.
- **`workspace-write`.** It always sends its writable roots, even an empty
  list, and its network flag. These replace any roots the stored thread
  collected.
- **Turns.** Each turn also carries the full `sandboxPolicy`, so read-only
  network access is explicit.

These combinations can't be enforced and are refused with category
`configuration`:

- writable roots outside `workspace-write`;
- `none` with network access off;
- an unknown policy value;
- a relative root.

Server requests are classified as follows:

- disabled user input gets empty answers at once;
- disabled elicitation is declined at once;
- under `never`, any approval request that still arrives is declined;
- tool calls go to the session's tools;
- any other method gets a JSON-RPC error.

Nothing waits for a UI.

The Claude permission helpers are public from `./claude` with the driver.
The Codex helpers become public from `./codex` with its driver (task 4.2),
which also checks their fields against app-server transcripts.

## Claude driver (`@motuslabs/agent-runtime/claude`)

`createClaudeDriver(options)` returns an inert driver. Call `start()` to
spawn the CLI. The launch configuration, permissions and callbacks you pass
are the only inputs. The driver reads no host settings files
(`settingSources` defaults to none).

- **Turns.** `send()` returns a handle bound to the UUID of the message it
  sent. A result completes a turn only if it names one of that turn's
  prompts. A result that names a previous turn's prompt, repeats an earlier
  frame, or names an unknown UUID completes nothing.
- **Queued messages.** `{ continuation: 'queue' }` queues a message behind
  the active turn. If the CLI merges it into that turn, both handles get the
  same result. If the CLI runs it next, it opens as its own turn, with no
  idle state in between. Claude has no `steer` mode; asking for it is
  refused with category `unsupported`.
- **Agent-started turns.** The CLI can start a turn while the driver is
  idle, for example when a background task finishes. That turn emits
  `turn_started` with a trigger (the task summaries, else `resumed`), but no
  `user_message` and no handle. Its result reaches `onTurnResult` with a
  `messageUuid` of null. An init that arrives while starting, stopping or
  after an exit opens nothing.
- **Requests.** Approvals and `AskUserQuestion` questions are registered
  before their events are emitted. `onRequest` may answer inline. A request
  still pending when `onRequest` returns is denied by default (decided by
  `policy`). With `unansweredRequests: 'wait'` it stays pending until
  `resolveApproval` or `answerQuestion` is called. Interrupt, stop and
  process exit cancel pending requests.
- **Session signals.** Slash commands (`onCommandState`), worker and
  background-task rosters, activity, compaction notices and model changes
  are reported the same way Kawai's in-tree driver reports them.

## Host integrations

Every integration is an option. Leave it out and the runtime registers,
records and observes nothing for it.

- **`tools`** is one namespace of host tools. Each has a name, a description,
  a Zod object schema and a handler. An absent or empty set registers no
  tools.
  - Claude serves them from an in-process SDK MCP server as
    `mcp__<namespace>__<tool>`. An explicit `enabledTools` list is exact. A
    bound tool runs only if that name is listed, so a host that exempts its
    own tools adds them to the list itself. Codex receives one `dynamicTools`
    namespace.
  - A handler runs only for this session's own thread, the bound namespace, a
    bound tool, and arguments that pass the full schema, refinements
    included. Any other call gets a `Refused: …` error result, and the
    handler never runs. A throwing handler becomes an error result.
  - Arguments are parsed exactly once, with the tool's own schema, so strict
    keys hold and transforms run once. On Claude, the SDK MCP server receives
    the full schema rather than its shape.
  - Each call is an owned job: `kill()` and `shutdown()` wait for a running
    handler. A call that arrives after stop has begun is refused.
  - On Claude, `toolCallId` is the MCP request id, because the CLI does not
    pass its `tool_use_id` to SDK servers.
- **`systemPromptAppend`** appends to the claude_code preset prompt on Claude.
  On Codex it goes into `developerInstructions` (task 4.2).
- **`beforeSubmit`** runs synchronously inside `send()`, before anything is
  enqueued or emitted. It receives the message UUID, turn id, text and the
  opaque `context` the caller passed.
  - A refusal or a throw rejects the send with category `context`. No user
    message, `turn_started` or `user_message` event follows.
  - An accepted submission keeps exactly the UUID and turn id that the
    callback saw.
- **`onToolObservation`** receives only the phase (`call` or `result`), the
  tool name, the call id, the turn and the error flag. It never sees
  arguments.
- **`auditHooks`** is the opt-in detailed adapter. Its `preToolUse` does
  receive the tool input.

Observers never decide anything, and their hooks always answer with no
decision. A throwing observer can't block, grant or repeat a tool call. Its
error is kept and reported when the session stops.

`wire` records raw protocol frames only when you supply it.
