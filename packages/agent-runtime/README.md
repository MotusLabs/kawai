# @motuslabs/agent-runtime

Headless Claude and Codex agent drivers, extracted from Kawai: explicit
launch authority, observable requests and results, an owned process stop and
resumable sessions. Kawai and headless Bun daemons use the same
implementation.

**Status: unreleased, under construction.** The public contract is frozen
(`src/contract.ts`, `src/options.ts`, `src/events.ts`). The Claude driver
has moved (`./claude`), and so has the Codex driver (`./codex`); both share
the events, results and usage facts of `./usage`. See `docs/api-differences.md` for how the contract differs from
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
The Codex composition stays internal: `createCodexDriver` applies it to
every `thread/start`, `thread/resume` and `turn/start`, and the tests check
those fields in the fake app-server's transcripts.

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
- **Process end.** When the CLI process ends unexpectedly (not through
  `kill()` or `shutdown()`), the driver becomes `exited` and reports one
  `error` (category `transport`) and one `onProcessEnd`. The running turn
  ends with outcome `process-ended` and a `turn_completed`. A queued turn
  that never opened gets the same result on its handle but no turn event.
  These results are fixed before any callback runs, `onState('exited')`
  included, so a stop or interrupt called from a callback cannot change
  them. A stop called from a callback starts the stop, but that call is
  refused with `internal`; call it again from outside to wait for it.
  `start()` launches a new process that resumes the conversation.
- **Checkpoints.** The CLI reports its session id in the init of a turn,
  not at `start()`. When that id is new, the driver calls
  `onCheckpoint({ runtime: 'claude', runtimeSessionId })` once. The id you
  passed as `resume` counts as already saved. Claude reports no transcript
  path, so `transcriptPath` is absent. The turn that revealed the id is
  already acknowledged and is not held. Every later `send()` resolves only
  after the persistence settled.
  - A refusal that applies when you call (`busy`, `unsupported`,
    `not-ready`, `stopped`) is still immediate.
  - Sends released together still open turns one at a time, in FIFO order.
  - `beforeSubmit` runs once the send stops waiting. The send is accepted
    only if, when it returns, nothing interrupted or stopped the driver
    meanwhile and the send is still admissible.
  - `interrupt()` refuses every send still waiting, at once, with category
    `not-ready`, code `interrupted`. A send waits for a persistence, for a
    start in progress, or for one yield after the call. This holds while
    idle too, for example for a send made after the previous turn
    finished. The interrupt does not wait for the persistence, which keeps
    running; a stop waits for it. The receipt is `requested` when a
    waiting send was refused. Idle with nothing waiting stays
    `no-active-turn`. A send made after the interrupt, even from a callback
    the interrupt triggers, is new work and waits as usual.
  - Two new ids persist one at a time, and a waiting send waits for both.
  - If `onCheckpoint` rejects or throws, the driver emits an `error` event
    with category `checkpoint` and shuts itself down. It never starts a
    fresh conversation. Waiting and later sends are refused with category
    `checkpoint`, carrying the raw cause. The stop's error lists the cause
    too. If the stop had already begun, the sends are refused as `stopped`.
  - A stop waits for a persistence in progress.
  - Calling `send()` from inside `onCheckpoint` would wait on itself, so it
    is refused at once with category `internal`. `kill()` or `shutdown()`
    from inside starts the stop, but that call is refused with `internal`.
    Call it again from outside to wait for the stop.
  - A first launch that crashes before reporting an id is not recoverable.
- **Resume.** To continue a saved conversation in a new driver, also in
  another host process, pass `resume: { runtime: 'claude', runtimeSessionId }`
  and the same retained homes (the launch's `homeDir` and child `HOME`, where
  the CLI keeps its transcripts). Any id the runtime accepts works, including
  one you hold yourself and your store failed to save. Every generation
  launches with `--resume=<id>` of the id the CLI reported last, so after an
  unexpected exit `start()` continues the same conversation, with the launch
  that generation reads and the same policy. The driver keeps no transcript
  catalog of its own and reports no transcript path.
  - The pinned CLI (2.1.289) checks the target before it answers initialize.
    If it refuses (no transcript under the homes, an invalid id), it exits,
    and `start()` rejects with category `resume`. No prompt is sent, no
    checkpoint is offered and no fresh conversation is started. The stop's
    error then lists the SDK's read error, the start failure and the
    process's exit. Only a resumed launch whose startup-failure frame or
    stderr carries the CLI's refusal is `resume`; any other early exit is
    `transport`.
  - If a runtime answers a resume with another conversation (or none) at its
    first init, the driver adopts nothing of it: no checkpoint, model or turn
    effect. Its open turns fail with category `resume`, later sends are
    refused with `resume`, and the driver shuts itself down. Those results
    are fixed before any callback runs, so a stop or interrupt called from a
    callback cannot change them. A queued turn that never opened gets its
    result but no turn event. After the first init named the target, a
    later new id is the runtime's own and is checkpointed as usual.
  - Verified with a fake CLI that follows 2.1.289's startup order (read from
    its source) across two host processes. This is not acceptance against
    the real CLI or a provider.
- **State publication.** `onState` reports a state after the step that
  entered it: `active` after the opening turn's `turn_started` and
  `user_message`, `idle` after the `turn_completed` or `turn_interrupted`
  that ended the turn. A state entered and left inside one step is not
  reported. `stopping` and `stopped` are reported at once.
- **Requests.** See [Answering requests](#answering-requests).
- **Session signals.** Slash commands (`onCommandState`), worker and
  background-task rosters, activity, compaction notices and model changes
  are reported the same way Kawai's in-tree driver reports them.

### Answering requests

Approvals and `AskUserQuestion` questions arrive through the SDK's
`canUseTool`, which the driver installs in every mode except
`bypassPermissions`. The deny-only `permissions` policy runs first, so a
request handler can't grant a tool the policy denies.

- **Order.** A request is registered before anything can see it. Its
  `approval_request` or `question_request` event is emitted next, then
  `onRequest` runs in the same call. Either may answer inline. The
  `request_resolved` event always follows the request event.
- **First terminal action wins.** That is a valid answer, an abort of the
  SDK's signal, `interrupt()`, `kill()` or `shutdown()`, an unexpected
  process exit, or the default denial. Later answers report `not-pending`.
  After stop has begun they report `stopped`. An invalid answer (an
  unoffered option, a second choice on a single-select question, a missing
  answer) or one of the wrong kind reports `invalid` and settles nothing.
  The request stays open for a valid answer.
- **Cancellation is an interrupting denial.** A cancelled tool never runs. A
  signal already aborted when the request arrives, or a stopping session, is
  denied at once, with no event and no `onRequest` call.
- **Unanswered requests.** A request still pending when `onRequest` returns
  is denied by default (`decidedBy: 'policy'`). That includes when
  `onRequest` is absent or throws; a throw is also kept and reported by the
  later stop. With `unansweredRequests: 'wait'` the request stays pending
  until you answer it or it is cancelled. The runtime arms no timer and
  waits for no UI.
- **Original facts.** Every event, `onRequest` argument and
  `pendingRequests()` result is a separate copy. Changing one never changes
  what an allow runs or how an answer is checked.
- `onRequest` runs even when the request event's handler has already
  answered. Its own answer then reports `not-pending`.

A headless host that answers inline
(`examples/inline-requests.ts`, compiled and run unchanged by the package
tests):

<!-- example: examples/inline-requests.ts -->
```ts
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import type { ClaudeAgentDriver, LaunchConfiguration, Logger } from '@motuslabs/agent-runtime'

// A headless host that answers every request inside onRequest: Read is
// allowed, every other tool is denied, and a question gets the host's own
// prepared answer. Nothing waits for a UI or a timer. If the driver refuses
// an answer (an empty or unknown one, say), the default denial applies.
export function headlessClaude(launch: LaunchConfiguration, logger: Logger, prepared: Record<string, string>): ClaudeAgentDriver {
  const driver: ClaudeAgentDriver = createClaudeDriver({
    launch,
    logger,
    permissions: { mode: 'default', enabledTools: ['Read', 'Bash', 'AskUserQuestion'], disallowedTools: [] },
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onRequest: (request) => {
        if (request.kind === 'approval') {
          driver.resolveApproval(request.requestId, request.tool === 'Read' ? 'allow' : 'deny')
          return
        }
        const answers = Object.fromEntries(request.questions.map((q) => [q.question, { text: prepared[q.question] ?? '' }]))
        const outcome = driver.answerQuestion(request.requestId, answers)
        if (!outcome.ok) logger.warn({ reason: outcome.reason }, 'answer refused; the request is denied')
      },
    },
  })
  return driver
}
```

## Codex driver (`@motuslabs/agent-runtime/codex`)

`createCodexDriver(options)` returns an inert driver. Call `start()` to
spawn one owned `codex app-server` with exactly the launch's environment and
working directory. The entry imports no SDK: a Codex-only host installs
neither the Claude Agent SDK nor anything beyond the package and `zod`.

- **Login.** `hasCodexLogin(codexHome)` reads `auth.json` of an explicit,
  absolute Codex home. It returns only whether the file holds a non-empty
  API key or access token. It never reads the host's home or environment,
  and never returns or logs a value. A missing or malformed file is `false`.
- **Start and checkpoints.** `start()` initializes the app-server and opens
  the thread (`thread/start`, or `thread/resume` for a supplied `resume`).
  A fresh thread's id is offered once to `onCheckpoint` as
  `{ runtime: 'codex', runtimeSessionId }`, and `start()` resolves only
  after that persistence settled. A rejection fails `start()` with
  category `checkpoint` and stops the driver; it never falls back to an
  unsaved thread. A resumed thread offers nothing: the id you passed counts
  as saved. Calling `start()` or `send()` from inside `onCheckpoint` is
  refused at once with category `internal`.
- **Resume.** Pass `resume: { runtime: 'codex', runtimeSessionId }` and the
  same retained Codex home, also in another host process. The thread the
  app-server returns must be the one you asked for; another thread (or a
  refusal) fails `start()` with category `resume`, adopts nothing and starts
  no fresh thread. `transcriptPath` is never used to choose a thread. Every
  resume and turn carries your own permissions, never the policy the thread
  was stored with. After an unexpected exit, `start()` resumes the same
  thread in a new process.
- **Turns.** A turn binds to the native turn id from the `turn/start` reply
  or its `turn/started` notification, never from a request or an item.
  `{ continuation: 'steer' }` joins the active turn with `turn/steer`
  (expecting that turn's id) and returns its handle; `queue` is refused
  with category `unsupported`. A turn the app-server starts by itself opens
  with trigger `resumed` and no handle.
- **Requests.** Approvals, user input and elicitation reach `onRequest`
  after they are registered, with the order and first-answer rules of
  [Answering requests](#answering-requests). Disabled user input gets empty
  answers and disabled elicitation is declined, at once. A `url` or
  `openai/userVerification` elicitation is an approval: allow accepts with
  no content.
- **Form elicitations.** A `form`, `openai/form` or `openaiForm`
  elicitation is one question. Its text is the server's message followed by
  the exact schema; its options are `Decline` and `Cancel`. To accept, type
  one JSON object, for example `{ text: '{"count":2,"remember":true}' }`.
  The driver checks it against the schema it captured (fields, required
  fields, types, bounds, formats, calendar dates and enum members, in nested
  objects too) and sends that object as the content. Fields the schema
  doesn't declare are refused. An answer that doesn't match is refused with
  `invalid` and the request stays pending. A schema the driver can't check
  exactly (an unknown keyword or format) is declined, and its exact shape
  is reported once per session as an `error` event with category
  `unsupported`; it is never narrowed. An interrupt cancels every waiting
  request; a stop cancels them and answers nothing more.
- **Failures.** An unauthorized protocol failure (`codexErrorInfo`
  `unauthorized`, or HTTP 401) is category `authentication`; a usage limit
  is `quota`; a rate limit or overload is `rate-limit`; a connection
  failure is `transport`. Credential values never appear in errors.
- **Process end and stop.** These follow the Claude driver's rules: the
  results of turns an unexpected exit ends are fixed before any callback
  runs, and `kill()` or `shutdown()` returns only after every process and
  host tool handler of every generation has finished.

<!-- example: examples/headless-codex.ts -->
```ts
import { createCodexDriver, hasCodexLogin } from '@motuslabs/agent-runtime/codex'
import type { CodexAgentDriver, LaunchConfiguration, Logger, ResumeCheckpoint } from '@motuslabs/agent-runtime'

/** The host's own durable store for the thread id. */
export interface CheckpointStore {
  load(): ResumeCheckpoint | null
  save(checkpoint: ResumeCheckpoint): Promise<void>
}

// A headless Codex host. It builds a driver only when the retained Codex home
// (the launch's homeDir, also its CODEX_HOME) holds a login, and nothing ever
// waits for a UI: approvals, user input and elicitation are off. A fresh
// thread's id is saved before start() resolves, so a later host process with
// the same homes resumes the same thread under this host's own policy.
export function headlessCodex(launch: LaunchConfiguration, logger: Logger, store: CheckpointStore): CodexAgentDriver | null {
  if (!hasCodexLogin(launch.homeDir)) return null
  const saved = store.load()
  return createCodexDriver({
    launch,
    logger,
    permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
    ...(saved ? { resume: saved } : {}),
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onCheckpoint: (checkpoint) => store.save(checkpoint),
    },
  })
}
```

This is verified against a fake app-server that follows protocol 0.163.0,
across two host processes. It is not acceptance against the real CLI or a
provider.

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
  On Codex it goes into `developerInstructions`.
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

## Events, results and usage (`@motuslabs/agent-runtime/usage`)

Both drivers emit the same `AgentEvent` stream and settle the same
`TurnResult`. The parsers and reducers behind them are exported from
`./usage`, which has no SDK dependency.

- **Events** are JSON values, normalized once on emission: a bigint becomes
  a string, a non-finite number `null`; `undefined` keys are dropped and a
  cycle becomes `null`. `sequence` counts from 1 per `streamId`, and a
  resumed driver starts a new stream, so stored event ids never collide.
- **Results** belong to the turn that produced them.
  - Claude: tokens are the turn's own result usage. Codex: they are the sum
    of the requests the turn made, as differences between the thread's
    running totals. A repeated or lower total adds nothing. A counter the
    previous total lacked is `null`, never the whole running total.
  - `toolCallCount` and `compactionCount` count distinct ids within the
    turn, so a later turn that reuses an id counts it again.
  - Claude's cost is the sum of the turn's `message_delta` costs, subagents'
    included. Its model is the turn's last main-thread assistant model.
  - Anything not reported stays `null`. Nothing is borrowed from an earlier
    turn.
- **Limit waits.** The first limit retry of a turn emits a `failure` and
  then a `wait-start`.
  - The wait ends `resumed` only at that turn's next observed progress, or
    at its success: a Claude request or assistant frame, or a Codex item,
    delta or token update that grew a counter. A stale or repeated total is
    not progress.
  - It ends `cancelled` when the turn ends otherwise or the driver stops,
    and `process-ended` on an unexpected exit.
  - A quota push, a non-limit retry or a reset time that passes never opens
    or ends a wait. Each `wait-end` names its `waitId`.
- **Quota reports** don't depend on turn state, and each names its `source`
  and `accountScope`.
  - Claude reports pushed `rate_limit_event`s (`push`, `session`).
  - Codex reads `account/rateLimits/read` once per driver after the first
    readiness (`report`, `session`) and reports each pushed update (`push`).
    A refused, unanswered or empty read reports nothing and fails nothing.
  - Claude's pull through the supplied home's login runs only with
    `quotaSource: 'host-login'` (`host-login-pull`, `host-login`). That
    login may be another account than a proxy session's, so it is off by
    default.
  - A host that reads a proxy account's windows itself labels them with
    `hostQuotaReport(...)` (`host-supplied`). The runtime never fills them in.
  - Without a source, no report arrives. A missing report means unknown,
    not "no limit".
- **Observers** (`onLimitEvent`, `onQuotaReport`, `onContextUsage`,
  `onCompaction`, `onModel`, `onEvent`, `onTurnResult`) are optional, and
  they only observe.
  - A throwing observer neither changes a result nor skips any of its
    settlement.
  - Each throw is reported exactly once, by identity, as a cause of the
    stop's `stop` error. It is never an unhandled rejection.
  - A control called from a turn's own result (its `turn_completed` or
    `error` event, `onTurnResult`, the result frame's context usage or
    final limit) acts on that decided turn only. `interrupt()` returns
    `no-active-turn` and reaches neither a queued successor nor one sent from
    the same callback. That successor opens after the callback returns. A
    stop still stops everything.
  - Checkpoint (`onCheckpoint`) and context (`beforeSubmit`) failures stay
    critical, as described above.
