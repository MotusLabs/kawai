# @motuslabs/agent-runtime

Headless Claude and Codex agent drivers, extracted from Kawai: explicit
launch authority, observable requests and results, an owned process stop and
resumable sessions. Kawai and headless Bun daemons use the same
implementation.

**Status: unreleased, under construction.** The public contract is frozen
(`src/contract.ts`, `src/options.ts`, `src/events.ts`); the drivers have not
moved yet. See `docs/api-differences.md` for how the contract differs from
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
`configuration`.

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

The Claude and Codex permission helpers become public with their drivers
(`./claude`, `./codex`, tasks 4.1 and 4.2). Task 4.2 also checks the Codex
fields against app-server transcripts.

## Host integrations

Every integration is an option. Leave it out and the runtime registers,
records and observes nothing for it.

- **`tools`** is one namespace of host tools. Each has a name, a description,
  a Zod object schema and a handler. An absent or empty set registers no
  tools.
  - Claude serves them from an in-process SDK MCP server as
    `mcp__<namespace>__<tool>`, and a restricted session counts them as
    enabled. Codex receives one `dynamicTools` namespace.
  - A handler runs only for this session's own thread, the bound namespace, a
    bound tool, and arguments that pass the full schema, refinements
    included. Any other call gets a `Refused: …` error result, and the
    handler never runs. A throwing handler becomes an error result.
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
