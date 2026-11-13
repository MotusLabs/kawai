# @motuslabs/agent-runtime

Headless Claude and Codex drivers for Bun >=1.3.0, ESM, with typed turns,
explicit launch authority and awaited process ownership. Version 0.1.0 is
unreleased. Native acceptance, publication and authenticated access receipts
are still required. Node 22 compatibility is optional and unverified.

## Installation

Install CLIs separately. Importing the package starts nothing. Codex-only
consumers need no Claude SDK; Claude consumers install exact SDK 0.3.289.
After owner publication, put this in the **consumer root** package.json:

```json
{
  "type": "module",
  "dependencies": {
    "@motuslabs/agent-runtime": "0.1.0",
    "@anthropic-ai/claude-agent-sdk": "0.3.289"
  },
  "overrides": {
    "@anthropic-ai/claude-agent-sdk-linux-x64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-darwin-x64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-win32-x64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0",
    "@anthropic-ai/claude-agent-sdk-win32-arm64": "npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0"
  }
}
```

Overrides in a library do not propagate. Kawai retains local `file:` overrides;
external consumers use all eight published aliases above. The empty companion
contains no CLI, dependencies or install hooks. Do not substitute SDK defaults.
Configure `.npmrc` with an environment placeholder, never a literal token:

```ini
@motuslabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Locally supply `NODE_AUTH_TOKEN` from a classic token with `read:packages`
and account access (authorize organization SSO when required), then run
`bun install` and commit the resulting lockfile without credentials.
For SmartFactory Actions, an administrator must grant that repository Read
under **Manage Actions access** on **both** packages. A trusted job uses its
own `GITHUB_TOKEN` as `NODE_AUTH_TOKEN` with `contents: read`, `packages: read`.
A 403 without that grant is an access failure; use an authorized read-token
fallback only by owner choice. A local packed install proves neither receipt.

## Compatibility and entries

| Component | Supported baseline | Evidence scope |
| --- | --- | --- |
| Bun | minimum 1.3.0; repository pin 1.4.3 | Controlled local consumers |
| Claude Agent SDK | exact 0.3.289, optional peer | Claude only |
| Claude Code | floor 2.1.289 | Controlled protocol; real acceptance separate |
| Codex | floor/protocol 0.163.0 | Controlled app-server; real acceptance separate |

| Entry | Surface |
| --- | --- |
| `@motuslabs/agent-runtime` | SDK-independent contracts, options, events, errors |
| `./claude` | `createClaudeDriver`, `RESTRICTED_CLAUDE_PERMISSIONS` |
| `./codex` | `createCodexDriver`, `hasCodexLogin(explicitAbsoluteHome)` |
| `./events` | Ordered JSON event and pending-request types |
| `./profiles` | Pure explicit credential/environment helpers |
| `./usage` | Token, cost, context, quota, limit/window and wait reducers/types |
| `./package.json` | Version metadata |

## Lifecycle and results

Factories are inert. Required options are `logger`, `launch`, `permissions`
and `callbacks.onEvent`. Optional `model` and `effort` select provider settings.
No tools, context, wire, server, listener or tmux
are required. `start(): Promise<void>` initializes without a model turn;
concurrent starts share initialization. `send(text, options?)` resolves to
`{ turnId, messageUuid, result }`. A default new turn requires idle; Claude
supports `continuation: 'queue'`, Codex supports `'steer'` (one shared turn
result). Unsupported modes refuse. Caller UUID and opaque JSON `context`
are optional. Codex `codexSkills: 'none'` suppresses native skill inputs for
one send; omitted/`auto` uses the runtime's own catalog. Claude refuses it.

`TurnResult` never rejects: outcome is `success`, `failed`, `interrupted`
or `process-ended`, with correlated identities, `finalText`, `model`, `usage`,
`toolCallCount`, `compactionCount`, `error`. Unknown measurements are `null`;
`cacheCreationTokens` means cache-write input tokens. Counts deduplicate IDs
within the turn. No prior-turn measurement is borrowed. An agent-started
turn has `messageUuid: null`, no handle, and reaches `onTurnResult` once.

`interrupt()` cancels pending requests and unacknowledged submissions,
settles active/queued turns, retains the conversation and reports
`{ outcome: 'requested' | 'no-active-turn', processExit: false }`.
It does not await checkpoint persistence. New callback-submitted work is new
work. Claude refreshes active-turn context immediately on interrupt.

`kill()` and `shutdown()` share one terminal promise and the first mode.
Both close admission, join every generation, process, tool handler and owned
callback. Success is `{ scope: 'agent-processes', mode, processes, js: 'settled' }`;
each process fact records generation/PID, actual code/signal, escalation and group clearance,
or `never-started`. EOF, signal acknowledgement and pipe drain are insufficient.
The scope excludes independently detached services: use host containment for
those. Stop rejects with category `stop` and retained causes if joins fail.
Call stop from the outside supervisor; a callback-owned self-join is refused
with `internal`, and the outside caller must still await the terminal stop.

`onCheckpoint({ runtime, runtimeSessionId, transcriptPath? })` belongs to
your durable store. Persist before resolving it: dependent sends wait, and
Codex start waits for its fresh thread checkpoint. Claude first learns its
ID during a turn; a crash before that is unrecoverable. A rejection refuses
dependent work with `checkpoint` and stops. Resume constructs a **new driver**
with the saved `resume` and the same retained homes/transcripts. Both stop
modes retain runtime data. A refused/mismatched target is `resume`, never a
fresh fallback. On unexpected exit, `onProcessEnd` fires once with generation,
code, signal and reason; results are fixed before callbacks, and `start()`
resumes the last identity. Requested stops do not call `onProcessEnd`.

Events are JSON values with stable IDs and increasing sequence per `streamId`.
Replay keeps stored IDs; reconstructed drivers create a new stream. Late
frames cannot complete another turn. Errors are `AgentRuntimeError` values
with safe `toJSON()`, category/code and retained causes; categories distinguish
configuration, dependency, authentication, quota, rate-limit, transport,
not-ready, busy, stopped, unsupported, resume, context, checkpoint and stop.

## Explicit launch and environments

`launch` is a configuration or a synchronous per-generation callback returning
`{ cwd, childEnv, executablePath?, homeDir, cacheDir, tempDir }`. Paths are
absolute; `childEnv` is complete, cloned per generation, never merged with
`process.env`. Supply HOME, PATH and provider homes explicitly. Missing
configuration fails before spawn. An omitted executable is resolved only
from the supplied PATH; a missing executable fails that runtime without
preventing imports or the other runtime. No CLI is downloaded automatically.
Use the matrix versions and verify CLI versions in your host preflight; the
package checks executable availability. Lookup and spawn use the supplied
launch environment.

Profile helpers take an approved `base` map and optional `withheld` names.
The entry also exports CLAUDE_AGENT_SDK_VERSION, credential-family name/prefix
sets and TRANSPORT_PIN_ENV for hosts inspecting the helper policy.
They remove conflicting authority, blank alternate credentials and preserve
explicit transport settings without mutating input. Non-secret `settings`
may be passed to Claude; never put secrets in settings or logs.

```ts
import { anthropicOAuthProfile, claudeProxyProfile, codexProfile } from '@motuslabs/agent-runtime/profiles'
const base = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
const oauth = anthropicOAuthProfile({ base, oauthToken: '<oauth-token>' })
const proxy = claudeProxyProfile({ base, baseUrl: 'https://api.z.ai/api/anthropic', authToken: 'placeholder', customHeaders: 'X-Api-Key: <proxy-key>' })
const codex = codexProfile({ base, codexHome: '/srv/agents/codex-home' })
// Merge only your approved HOME/cache/temp inputs into these childEnv maps.
// Pass oauth.settings or proxy.settings as Claude's settings option.
```

## Permissions and requests

Claude `permissions` separates `mode` (`default`, `acceptEdits`,
`bypassPermissions`, `plan`, `dontAsk`), `enabledTools` (exact names or `all`)
and `disallowedTools`. A deny-only PreToolUse hook runs first on every
resume/respawn: unlisted/disallowed tools cannot run even in bypass mode.
Rules/wildcards such as `Bash(git:*)` are refused. Restricted v1 allows only
Read/Glob/Grep and denies AskUserQuestion/Edit/Write/MultiEdit/NotebookEdit
and **all Bash**. There is no shell command parser or command allowlist.
`settingSources` defaults to none; opt into user/project/local explicitly.

Codex `permissions` requires `approvalPolicy` (never/on-request/untrusted),
`sandbox` (workspace-write/read-only/none), `networkAccess`, absolute
`writableRoots`, `userInput` and `elicitation` (enabled/disabled).
Policy is reapplied on thread start, resume and turns. None explicitly means
danger-full-access; it cannot combine with network off. Writable roots require
workspace-write. Disabled requests are answered/declined immediately. The
runtime never inherits a broader saved policy. `hasCodexLogin` returns only
structural login validity from your explicit home, never credentials.

Requests register before their event and `onRequest`. Answer inline with
`resolveApproval(id, 'allow' | 'deny', { decidedBy? })` or
`answerQuestion(id, answers, { decidedBy?, response? })`. Answers map question
text to `{ text }` or `{ options: string[] }`; choices and multiplicity are
validated. `response` is a nonblank explanatory string only for Claude
questions; elsewhere it is invalid and consumes nothing. First valid answer,
abort or cancellation wins. Outcomes are `{ ok: true }` or
`{ ok: false, reason: 'invalid' | 'not-pending' | 'stopped', message }`.
`pendingRequests()` returns isolated copies. Claude's optional `toolCallId`
is native correlation only; `requestId` is the settlement key.

Default `unansweredRequests: 'deny'` safely denies a missing/throwing handler
or unanswered request. `wait` is an explicit host UI choice; the runtime arms
no deadlines. Never await stop from inside a request callback. Codex form
elicitations accept typed JSON through `{ text: '<JSON object>' }`, validated
against the captured schema; unsupported schemas decline with `unsupported`.
URL/verification elicitations are content-free approvals.

## Seams and callbacks

Required `logger` is object-first (`debug/info/warn/error(obj, message?)`);
the package creates no log transport. Optional integrations remain inert
when absent. `systemPromptAppend` adds Claude preset/Codex developer text.
`tools: { namespace, tools: [{ name, description, inputSchema, handler }] }`
uses Zod; omitted/empty means no host tools. Identity, namespace and full
schema validation precede each owned async handler. Unknown/invalid calls
refuse without invocation. `onToolObservation` sees names/IDs/phases/error
only. Opt-in `auditHooks` sees detailed inputs (`preToolUse`, `postToolUse`,
Claude `onHook`; Codex `onItem`). Opt-in `wire.record(frame)` sees raw frames;
never log it by default.

`beforeSubmit` synchronously returns `{ accepted: true }` or
`{ accepted: false, reason }` before enqueue/events; receives the minted
UUID, turn ID, text and opaque context. Claude `composePrompt` runs next,
returning optional copied `pastedContent`/peer `origin`. A throw, thenable
or malformed value refuses with `context`. `joinAgentStartedTurns: true`
optionally joins a queue send to the sole agent-started turn; callbacks see
that identity, which is rechecked before enqueue. Default false keeps queues.
Codex `getEffort` reads effort per new turn; `claimRateLimitsRead` claims one
account read per generation. `onThreadOpened` reports generation/thread/path
(or null)/resumed after checkpoint before ready. `setSkillDirectory` moves
only the live catalog, not thread or launch cwd; sends while loading are text
only. Claude `claimUsagePull` optionally claims its host-login read.

| Callback | Facts / ownership |
| --- | --- |
| `onEvent` | Required ordered core JSON events |
| `onState` | unstarted/starting/idle/active/stopping/stopped/exited |
| `onRequest` | Registered approval/question, may answer synchronously |
| `onCheckpoint` | Critical awaited identity persistence |
| `onTurnResult` | Same completed value as handle; agent turns included |
| `onProcessEnd` | Unsolicited process generation exit only |
| `onModel`, `onCompaction` | Model, distinct completed boundary/turn/preTokens |
| `onContextUsage` | Usage or null; optional persist/thresholdSource metadata |
| `onLimitEvent`, `onQuotaReport` | Correlated waits and independent account windows |
| `onActivity`, `onWorkers`, `onBackgroundTasks` | Current pure rosters/facts |
| `onNotification`, `onCommandState` | Notice/optional expiry; available commands |
| `onCwdChanged`, `onSpawn` | Observed cwd; launch provenance (contains env: keep private) |
| `onCompactionObservation` | Start/end/trigger/source and nullable measured facts |
| `onQuotaNoData` | Attempted permitted read with no windows, source/account scope |

Callbacks with a void return signature should stay synchronous. Hosts own
async work those callbacks start; the combined example captures and joins
its async print promises explicitly. `onCheckpoint` is explicitly awaitable.

Observers cannot grant permissions or alter outcomes. Their failures are kept
and reported once by the outside stop without skipping result/usage settlement.
Checkpoint/context failures stay critical. A result-publication interrupt
acts on that decided turn, never a queued successor. Claude-only
`getTaskOutput(id)` and `stopTask(id)` probe background tasks; unknown tasks
return null/false; known output is `{ output, totalBytes, truncated }`.
Host policy, stores, request deadlines and caches stay outside.

## Usage, rate waits and quota

`onTurnResult` contains actual per-turn tokens/model/counts. `onLimitEvent`
adds one `wait-start` and matching `wait-end` with `waitId`; resumed means
observed retry progress/success, never a reset clock or quota push. Interrupt
and stop end waits as cancelled; unexpected exit uses process-ended.
`onQuotaReport` is independent of turns, even idle/request-pending. It names
source (push/report/host-login-pull/host-supplied), accountScope and normalized
windows with known percentages/resets. Missing facts stay null/unknown.
Claude host-login pulls are off unless `quotaSource: 'host-login'`; this login
may differ from a proxy's account. Codex reads once by default, or only when
`claimRateLimitsRead` grants the generation. Pushes remain observable either
way. Denied/unattempted reads report neither data nor no-data.
`hostQuotaReport` labels explicit host input; no proxy endpoint is invented.
An unavailable report means unknown, not unlimited. Safe output prints only
outcome, numeric measurements, sources and wait kinds, never raw protocol,
question text, tool inputs, credentials or the complete launch environment.

## Headless examples

`examples/headless.ts` exports a supervisor with both factories, inline
answers/denials, cooperative interrupt, awaited kill and reconstruction from
saved identity. Importing it makes no live calls. Supply authorized isolated
launches and your own durable store. Controlled tests invoke the same example
with separately configured fake CLIs; real-provider evidence remains task7.4.
These smaller recipes are also compiled and run unchanged by controlled tests:

<!-- example: examples/inline-requests.ts -->
```ts
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import type { ClaudeAgentDriver, LaunchConfiguration, Logger } from '@motuslabs/agent-runtime'

// A headless host that answers every request inside onRequest: Read is
// allowed, every other tool is denied, and a question gets the host's own
// prepared answer. Nothing waits for a UI or a timer. If the driver refuses
// an answer (an empty or unknown one, say), the default denial applies.
// The caller owns the returned driver and awaits stop in an outside finally,
// including after start/send/output failure; callbacks never join their owner.
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

<!-- example: examples/headless-codex.ts -->
```ts
import { createCodexDriver, hasCodexLogin } from '@motuslabs/agent-runtime/codex'
import type { CodexAgentDriver, LaunchConfiguration, Logger, ResumeCheckpoint } from '@motuslabs/agent-runtime'

/** The host's own durable store for the thread id. */
export interface CheckpointStore {
  load(): ResumeCheckpoint | null
  save(checkpoint: ResumeCheckpoint): Promise<void>
}

// Ownership transfers to the caller: always await shutdown() in an outside
// finally after construction, including when start(), send() or output fails.
// A headless Codex host. It builds a driver only when the retained Codex home
// (the launch's homeDir, also its CODEX_HOME) holds a login, and nothing ever
// waits for a UI: approvals, user input and elicitation are off. A fresh
// thread's id is saved before start() resolves, so a later host process with
// the same homes resumes the same thread under this host's own policy. A host
// running several drivers on one login passes claimRateLimitsRead, so only
// the generation its own state picks sends the one account rate-limit read.
export function headlessCodex(launch: LaunchConfiguration, logger: Logger, store: CheckpointStore, claimRateLimitsRead?: () => boolean): CodexAgentDriver | null {
  if (!hasCodexLogin(launch.homeDir)) return null
  const saved = store.load()
  return createCodexDriver({
    launch,
    logger,
    permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
    ...(saved ? { resume: saved } : {}),
    ...(claimRateLimitsRead ? { claimRateLimitsRead } : {}),
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onCheckpoint: (checkpoint) => store.save(checkpoint),
    },
  })
}
```
## Development and release preparation

Root `bun run typecheck`, lint/test/check include this package. Package
`bun run build` emits ESM JS/declarations into ignored dist; remove stale
dist before source typechecks. Run individual files through
`bun run test packages/agent-runtime/__tests__/<file>.test.ts`.

Runtime versions/changelog are independent of Kawai application versions.
A breaking documented API requires a new **major**, even after 0.x, with
migration notes. Published versions are immutable; fix forward, never replace.
The separate `agent-runtime-v<version>` workflow checks the exact commit,
then requires an owner-protected `agent-runtime-release` environment and
AGENT_RUNTIME_ACCEPTED_SHA, AGENT_RUNTIME_NATIVE_SHA,
AGENT_RUNTIME_AUTHORIZED_SHA repository variables equal to that commit.
The publication job refuses to start without all three pins. The owner sets them only
after assembled checks/cross-model review, real native evidence and explicit
publication authorization respectively. No pins are assumed here. Untrusted
PRs cannot publish. The companion publishes before runtime; partial failures
need owner reconciliation without overwriting either immutable artifact.
See the owner-visible `docs/api-differences.md` for agent-host migration.

The combined supervisor below is shipped and tested unchanged from the pack.
It only runs when your application calls `runHeadless`; provide two explicit
provider configurations, `load/save` backed by your durable checkpoint store,
host-prepared answers, prompts and a safe `print` sink. Keep the same homes
for reconstruction. Use isolated fake CLIs for controlled tests and explicitly
authorized accounts for real turns. No native acceptance is inferred here.

<!-- example: examples/headless.ts -->
```ts
// Public consumer supervisor. Import is inert: callers supply authorized
// launches, host answers, durable checkpoint storage and their own prompts.
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { AgentDriver, AgentCallbacks, ClaudeDriverOptions, CodexDriverOptions, ResumeCheckpoint, TurnResult, ProcessExitReceipt } from '@motuslabs/agent-runtime'

export type HeadlessProvider =
  | { runtime: 'claude'; options: Omit<ClaudeDriverOptions, 'callbacks' | 'resume'> }
  | { runtime: 'codex'; options: Omit<CodexDriverOptions, 'callbacks' | 'resume'> }

export interface HeadlessHost {
  load(runtime: 'claude' | 'codex'): ResumeCheckpoint | undefined
  save(checkpoint: ResumeCheckpoint): Promise<void>
  answers: Readonly<Record<string, string>>
  prompts: Record<'claude' | 'codex', { turns: readonly string[]; interrupt: string; resume: string }>
  /** Safe numeric/status facts only; never raw events, prompts or authority. */
  print(facts: object): void | Promise<void>
}

export interface HeadlessResult {
  turns: TurnResult[]
  stops: ProcessExitReceipt[]
}

/** Outside supervisor owns all stops; callbacks only answer and observe. */
export async function runHeadless(providers: readonly HeadlessProvider[], host: HeadlessHost): Promise<HeadlessResult> {
  const owned: AgentDriver[] = []
  const result: HeadlessResult = { turns: [], stops: [] }
  const failures: unknown[] = []
  const output: Array<Promise<PromiseSettledResult<void>>> = []
  let closing = false
  // Runtime observers are synchronous. This example owns async sinks itself;
  // each rejection is observed immediately and joined by the outside owner.
  const publish = (facts: object): void => {
    if (closing) return
    const printed = host.print(facts)
    if (printed) output.push((async (): Promise<PromiseSettledResult<void>> => {
      try {
        await printed
        return { status: 'fulfilled', value: undefined }
      } catch (reason) {
        return { status: 'rejected', reason }
      }
    })())
  }
  const construct = (provider: HeadlessProvider, resume?: ResumeCheckpoint) => {
    let driver: AgentDriver
    const callbacks: AgentCallbacks = {
      onEvent() {},
      onCheckpoint: (checkpoint) => host.save(checkpoint),
      onRequest(request) {
        if (request.kind === 'approval') driver.resolveApproval(request.requestId, 'deny')
        else driver.answerQuestion(request.requestId, Object.fromEntries(request.questions.map((question) => [question.question, { text: host.answers[question.question] ?? '' }])))
      },
      onTurnResult: (turn) => publish({ runtime: provider.runtime, outcome: turn.outcome, usage: turn.usage, toolCallCount: turn.toolCallCount, compactionCount: turn.compactionCount }),
      onLimitEvent: (event) => publish({ runtime: provider.runtime, limit: event.type, ...('cause' in event ? { cause: event.cause } : {}) }),
      onQuotaReport: (report) => publish({ runtime: provider.runtime, source: report.source, accountScope: report.accountScope, windows: report.windows.map((window) => ({ percentUsed: window.percentUsed, resetsAt: window.resetsAt })) }),
    }
    driver = provider.runtime === 'claude'
      ? createClaudeDriver({ ...provider.options, callbacks, ...(resume ? { resume } : {}) })
      : createCodexDriver({ ...provider.options, callbacks, ...(resume ? { resume } : {}) })
    owned.push(driver)
    return driver
  }
  try {
    for (const provider of providers) {
      const prompts = host.prompts[provider.runtime]
      const driver = construct(provider, host.load(provider.runtime))
      await driver.start()
      for (const prompt of prompts.turns) result.turns.push(await (await driver.send(prompt)).result)
      const pending = await driver.send(prompts.interrupt)
      const interrupt = await driver.interrupt()
      result.turns.push(await pending.result)
      await host.print({ runtime: provider.runtime, interrupt: interrupt.outcome, processExit: interrupt.processExit })
      result.stops.push(await driver.kill())
      const saved = host.load(provider.runtime)
      if (!saved) throw new Error(`No persisted ${provider.runtime} identity to resume`)
      const resumed = construct(provider, saved)
      await resumed.start()
      result.turns.push(await (await resumed.send(prompts.resume)).result)
      result.stops.push(await resumed.shutdown())
    }
  } catch (error) {
    failures.push(error)
  } finally {
    closing = true
    // allSettled attempts every stop, even after a primary or earlier stop
    // failure. No callback calls this owner or awaits its own disposal.
    const joined = await Promise.allSettled(owned.map(async (driver) => driver.shutdown()))
    for (const outcome of joined) if (outcome.status === 'rejected' && !failures.includes(outcome.reason)) failures.push(outcome.reason)
    for (const write of await Promise.all(output)) if (write.status === 'rejected') failures.push(write.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'headless run and cleanup failed')
  return result
}
```
