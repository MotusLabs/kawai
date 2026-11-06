# Design

## Context

See [proposal.md](proposal.md) for motivation and the three delta specs for requirements. These are proposed changes, not claims that the current drivers satisfy the headless contract.

Discovery baseline: Kawai `origin/master` at `6ee6bea8`, Claude SDK `0.3.289`, Claude CLI floor `2.1.289`, generated Codex protocol and CLI floor `0.163.0`. Installed SDK declarations also report `0.3.289`. No CLI, real credential or candidate program was executed during planning.

| Observed source | Consequence |
| --- | --- |
| `provider/driver.ts` imports shared team, workspace and observation types; start/send/kill/shutdown return void | Extract a runtime-owned type layer and provide Kawai compatibility adapters |
| `ChatSessionDriver.ts:785-943` resolves Kawai catalogs, installs team/audit hooks, selects settings sources and launches detached initialization/loop/usage work | Separate policy composition from transport and retain real asynchronous work |
| `ClaudeProfiles.ts:95-140,169-253`, `chatProviderEnv.ts:74-87` read/merge host environment and catalogs | Extract pure credential-neutralization helpers; leave discovery and credential-store access in Kawai |
| `codexThread.ts` hard-codes on-request/user approvals, requires a wire recorder and defaults serverEnv to process.env | Make policy, recorder and complete environment explicit |
| `codexSandbox.ts` imports Kawai Git execution to discover the common directory | Caller supplies extra writable roots; Kawai discovers its common directory before construction |
| `AppServerClient.whenExited()` exists, but the driver's selected client surface omits it | Carry the actual exit boundary through the driver |
| Codex end signals a group, but a bounded pipe drain and leader exit do not establish that descendants ended | Track requested stop, actual exits and owned group cleanup separately |
| `wireTap.ts:76-169` owns a Claude child only when recording is enabled; SDK Query.close() is void | Extract an always-present owned spawner with optional recording, not a receipt inferred from Query.close() |
| `codexRequests.ts` and Claude canUseTool register requests before emitting them | Preserve reentrant, immediate programmatic answers |
| `shared/chat.ts` mixes core ChatEvents with peer/task/workspace payloads | Move core definitions once; keep Kawai-specific union members and enrichment in Kawai |
| Root package has local file overrides for eight Claude platform packages; no workspaces field | Add workspace consumption and a portable consumer-root override recipe |
| CI builds/tests Kawai; release.yml publishes compiled application binaries on v* tags | Add a separate package release path without changing application versioning |

Read the existing `codex-chat-sessions` and `claude-session-profiles` requirements and scenarios. Their Kawai interactive policy, trusted catalog configuration, audit exemptions and persisted runtime identity remain binding. The new package's headless policy is an explicit alternative supplied by its host, not a change to Kawai's UI or catalog API.

Concurrent tool-call-metrics work (task-51e4eae0) has an uncommitted, unreviewed optional **JavaScript** settlement receipt (`settled()`, Claude driver only) and keeps void stop APIs. It is not a prerequisite: the owner decided this change implements its own stop/join from master for both runtimes and imports none of that diff. Neither that work nor its scoped tests are native-exit evidence. Manager/mailbox settlement, observation finalizers and History recovery witnesses belong to that change.

## Goals / Non-Goals

**Goals:** one implementation used by Kawai and a clean Bun consumer; explicit launch authority; observable requests/results; owned stop and resume boundaries; independently verifiable packed distribution.

**Non-Goals:** moving the session manager, Kawai databases/catalogs/credential store, mailbox/envelopes/team prompts, plans/strategy, routes/ws, tmux or UI; building agent-host or Temporal workflows; bundling CLIs; new quota-account discovery; promising Node compatibility without checks; an OS security boundary for arbitrary programs launched outside runtime ownership.

## Decisions

### 1. Package boundary and dependency ownership

Use `packages/agent-runtime/` in the Kawai repository. Export ESM plus declarations from `.`, `./claude`, `./codex`, `./events`, `./usage` and `./profiles`. Root/events/usage imports have no SDK initialization, process spawn, logger destination or filesystem configuration side effects. Exported types never refer to Kawai paths or either provider's protocol types.

| Source group | Package destination / retained responsibility |
| --- | --- |
| Runtime slice of provider/driver and shared/chat | `src/contract.ts`, `src/events.ts`, `src/usage/types.ts`; Kawai owns Session/WebSocket/peer/workspace additions |
| ChatSessionDriver and pure turn binder, queue, content, timer and command helpers | `src/claude/` and small `src/common/` modules |
| Activity/context/worker/background reducers required by current Claude features | Move their pure definitions and reducers, preserving Kawai projections and callbacks |
| claudeExecutable/executableVersion | `src/process/`; injected PATH/environment for resolution and version checks |
| ClaudeProfiles credential blanking/transport pinning | Pure `src/profiles/` helpers only; catalog loading, retained-name DB and trusted wrapper policy stay in Kawai |
| codex driver/client/events/requests/thread/usage/limits/activity/sandbox/auth and executable | `src/codex/`; remove Git, team, logger and outbound imports |
| Generated protocol directory | Internal `src/codex/protocol/`, unchanged generation provenance/VERSION and required notices; not a public API |
| usageLimits/usageWindowPeriods/limitSignals/contextUsage/providerCost | `src/usage/`; provider account stores, routing/cooldowns and Kawai quota HTTP services remain in Kawai |
| codexTools/audit and Claude audit hooks | Generic tool dispatch/observation in package; Kawai supplies namespace, descriptions, schemas, handlers and optional detailed audit adapter |
| wireTap process wrapping and linear line splitter | `src/process/`; optional sink, always-owned process |
| codexRollout/history replay, smoke scrubber and application fixtures | Stay in Kawai or tests; no library dependency on transcript UI/recovery stores |

Use the pinned Claude SDK as an **optional peer** with an exact supported version for 0.1.0, and as a development dependency for package tests. A Codex-only import needs no SDK. A Claude start without the peer fails with a typed dependency error, never a bundled executable fallback. The CLI remains external and version-checked. Reuse Zod 4 for generic tool schemas, preserving the existing schema-to-JSON conversion and validation path instead of introducing another schema converter.

Build JavaScript and declarations with a package-specific TypeScript configuration, explicit ESM exports and a files allow-list. Do not bundle the SDK, CLIs, fixtures or Kawai server into dist. Preserve MIT attribution from the repository and verify third-party SDK/generated-type notices before shipping.

Alternative rejected: copying drivers into SmartFactory or shipping src/server/chat wholesale. Both leave server dependencies or create two implementations.

### 2. Public driver contract

The following is the proposed consumer surface, to freeze at the design checkpoint before broad implementation. Type homes are `src/contract.ts`, `src/events.ts` and `src/options.ts` under the package.

```ts
interface AgentDriver {
  start(): Promise<void>; // ready; no model turn
  send(text: string, options?: SubmitOptions): Promise<TurnHandle>;
  interrupt(): Promise<InterruptReceipt>; // cooperative; processExit is false
  kill(): Promise<ProcessExitReceipt>;
  shutdown(): Promise<ProcessExitReceipt>; // retains runtime data
  resolveApproval(id: string, decision: 'allow' | 'deny'): AnswerOutcome;
  answerQuestion(id: string, answers: QuestionAnswers): AnswerOutcome;
}
interface TurnHandle {
  turnId: string;
  messageUuid: string;
  result: Promise<TurnResult>;
}
interface ResumeCheckpoint {
  runtime: 'claude' | 'codex';
  runtimeSessionId: string;
  transcriptPath?: string;
}
interface ProcessExitReceipt {
  scope: 'agent-processes';
  processes: readonly ProcessExitFact[]; // generation, code/signal or never-started
  js: 'settled';
}
interface InterruptReceipt {
  outcome: 'requested' | 'no-active-turn';
  processExit: false;
}
```

TurnResult contains the correlated identity; outcome `success|failed|interrupted|process-ended`; finalText or null; model or null; usage plus explicit availability; unique tool-call count; compaction count; and a safe typed error when applicable. Keep current usage names, including `cacheCreationTokens` meaning cache-write tokens. Never infer missing data from another turn.

`SubmitOptions` carries an optional caller message UUID, continuation mode and opaque JSON context. Default is a new turn accepted only when idle. Explicit queue/steer capabilities preserve current Claude queueing and Codex steering for Kawai; a steered message joins its actual turn handle/result, not an invented second completion. Reject unsupported continuation modes explicitly.

Factories construct an inert driver so callbacks can safely reference it before start. Explicit start is required; repeated start shares initialization. Unexpected exit requires start/resume before new send. A killed/shut-down driver is terminal; resume uses a new driver and retained checkpoint.

The caller persists checkpoints through `onCheckpoint(checkpoint): void|Promise<void>`. IDs can first arrive during initial runtime work; no promise is made that a first launch which crashes before reporting an ID is recoverable. Await persistence before acknowledging subsequent submissions depending on that checkpoint. A persistence rejection fails the dependent work, requests stop and remains observable; it cannot silently fall back to a fresh conversation.

Keep SDK and runtime IDs separate from host session IDs. Reapply caller policy on each resume. A rejected/missing resume target is an error, never an implicit new session. The package owns no SQLite table, transcript catalog or credential copy.

### 3. Process ownership, stop and error semantics

The default local process owner uses the existing Node child-process substrate on Bun and owns each spawned generation from before listener installation through terminal join. Claude always supplies SDK spawnClaudeCodeProcess; optional wire capture decorates this spawner. Codex carries AppServerClient's actual exit promise through its driver.

The pinned SDK's SpawnedProcess interface exposes exit/error listeners, kill, exitCode and signalCode (`sdk.d.ts:9437-9520`); Query.close() only stops its stream (`3243`). That supports retaining a real child handle. Do not infer native death from isDead, child.killed, an SDK result, stream EOF, interrupt acknowledgement or a timer.

For stop: close admission; retain active and retired generation references; cancel pending request promises; end the prompt queue; request SDK/query close and process stop; wake producers/held controls; then join all owned driver, provider-control, initialization, usage, context and tool-handler work plus actual process exit. Stop must not wait for natural stream idleness before closing it. Joining is initiated by the external owner, never from a loop awaiting itself.

Use a terminal memoized stop promise shared by kill/shutdown callers. The first stop fixes the terminal mode; both retain transcripts. Reject new admission synchronously after stop begins. Retain raw failures before existing fallback handlers; cancellation is expected only for the specific operation cancelled by this stop. Aggregate original body and cleanup failures; never return a successful receipt with hidden failures or unhandled rejections. Internal optional JS receipts may remain unsupported for custom providers; the public default local stop must fail explicitly if full required ownership cannot be established.

On supported POSIX hosts, create an owned process group and terminate the group, including escalation if the leader exits early. Preserve an actual leader-exit receipt separately from pipe-drain completion. Test a helper descendant that holds inherited pipes and continues writes. Do not cancel group cleanup merely because the leader exited. Reuse no workspace until the driver's owned processes and JS jobs are terminal. Arbitrary independently detached services and caller-owned processes are outside this receipt: the caller's pod/process containment must stop those before reusing their resources. Custom spawn adapters without native receipt capability are unsupported for forced-stop acceptance. Platform support beyond the first tested Linux container must be listed, not inferred.

Unsolicited exit reports onProcessEnd once per generation, with safe code/signal/reason, and resolves affected turn results as process-ended. Requested stops use their receipt. A callback describing exit does not by itself constitute a receipt for all generations.

Alternative rejected: adding settled() to Query and treating it as native exit. The concurrent S1 design intentionally provides only a JS receipt.

### 4. Complete environments, profiles and permission configuration

Required launch options include absolute cwd, complete `childEnv: Readonly<Record<string,string>>`, executable path (or resolution through that map's PATH), and explicit home/cache/temp locations. Clone, validate and freeze a complete configuration per process generation. SmartFactory supplies a fixed session configuration. Kawai may supply an explicit synchronous `getLaunchConfiguration()` callback to preserve catalog/retained-name refresh on respawn; only the caller reads host settings. A failed refresh refuses the new launch. Each generation and its executable check share one resolved configuration, without a mid-spawn mixture of inputs.

All executable checks and subprocesses use that map. Set cwd on the actual Codex process as well as thread parameters. No package code reads process.env, os.homedir, KAWAI_* settings or Kawai catalogs to discover launch authority. SDK-provided SpawnOptions cannot reintroduce ambient variables: enforce the caller-approved final map in the owned spawner. If the SDK needs a protocol variable, surface/document it through the helper's returned map and test it; no secret or host environment merge is permitted.

Pure helpers accept base, selected provider values and explicit withheld credential names. They produce final environments and non-secret controlled settings. Anthropic selects OAuth and neutralizes proxy/API-token alternatives. A proxy profile preserves ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS and its selected placeholder token, blanking Anthropic OAuth/API-key alternatives and removing supplied foreign credential names. Codex selects CODEX_HOME and removes Claude/provider credentials. Never put token/header values into argv, logs or spawn reports. Kawai's registered-name collision refusal and trusted-wrapper branches remain in its adapter and retain existing tests.

Headless settings default to no user/project/local settings sources, external MCP servers or plugins. Caller-provided homes are the only allowed login/transcript source; a shared Codex home is explicit authority to use that owner's login, not a credential copied into events. SDK configuration must be tested against poisoned operator homes and settings as well as environment variables. Kawai explicitly requests its existing settings behavior.

Claude permissions are independent options: mode, disallowedTools, explicit enabled tools and interaction handling. Restricted v1 uses bypassPermissions + its required opt-in flag, read-tool set, the five named denials and **Bash denied entirely**. A deny-capable PreToolUse policy also rejects all unlisted tools; observation hooks cannot override it. Do not represent allowedTools as a security allow-list or depend on canUseTool being called under bypass. Anthropic documents this evaluation order; validate against the pinned CLI, not merely current docs. [Permission ordering](https://code.claude.com/docs/en/agent-sdk/permissions).

A Bash command allow-list is deferred because the user permits total Bash denial in v1. No new shell parser is needed. Kawai's normal interactive mode remains an explicit adapter configuration; provider selection never grants permissions.

Codex options expose approvalPolicy (headless never), sandbox mode, network and writable roots, plus request-user-input/elicitation enablement. Map caller `none` to the pinned protocol's `danger-full-access`; never silently default it to workspace-write. Override persisted/home settings on start and resume. Disabled unexpected requests still reach onRequest and are immediately denied/cancelled unless the configured headless handler supplies its fixed response. Unknown request methods fail closed.

### 5. Host seams and reentrant requests

| Option | Contract / Kawai adapter responsibility |
| --- | --- |
| logger | Required pino-compatible debug/info/warn/error object-first methods; Kawai adapts its message-first wrapper; package creates no transports |
| tools | Default empty namespace table; entries have name, description, Zod schema and handler; validate names/schema and current thread before invocation |
| systemPromptAppend | Per-session string; Kawai builds role/security/team text before construction |
| beforeSubmit | Optional synchronous callback receiving minted message/turn IDs and opaque context, returns accepted/refused; refusal precedes visible turn/enqueue |
| onToolObservation | Optional names/IDs/phases only, never tool arguments; cannot affect permission or transport |
| auditHooks | Explicit opt-in detailed provider hook adapter for Kawai's existing audit coverage, with no outbound module import |
| wire | Optional raw recorder; no default file, log or listener; absence changes no process ownership |
| callbacks | onEvent/onStatus/onRequest/onProcessEnd/onCheckpoint/onTurnResult/onModel/onCompaction/onContextUsage/onLimitEvent/onRateLimit/onUsageReport plus preserved optional activity/roster/command signals |
| runtime test seams | Controlled query/client/spawn factories with explicit ownership capabilities; package tests use them without claiming native proof from iterator completion |

Use the same generic tool table for Claude in-process MCP and Codex dynamic tools. Namespace descriptions/identity are caller data, not hard-coded kawai-team. Unknown names, another thread, invalid arguments, handler failure and an empty table produce structured refusals. Tool operations and argument schemas never require a Kawai store.

Register each pending request, publish its request event, then invoke onRequest in the same dispatch. The callback may immediately call answerQuestion/resolveApproval; the resulting resolved event must follow the request event. Preserve first-valid-answer semantics and cancel-versus-answer races. Headless options disable auto-answer timers and supply an immediate response/denial; missing/throwing headless handlers deny safely. Kawai retains question timers and live policy switches through its adapter and current request APIs. Never await a UI.

Dispatch observer callbacks safely without changing protocol order. An observer throw cannot prevent internal usage/result settlement. Report callback failures through the safe logger/error path; critical checkpoint or pre-submit failures remain failures. Request callbacks do not await kill/shutdown from inside a provider handler; the external supervisor owns disposal, avoiding a self-join cycle.

### 6. Event, result and quota semantics

Move only SDK-independent core ChatEvent/activity/usage types. Kawai extends/enriches user/peer events in `shared/chat.ts`; no team/handoff/workspace imports enter the package. Use one emitter for stable event IDs and increasing sequence within an explicit stream/generation identity. Archive replay retains the stored IDs; a resumed emitter uses a fresh stream identity, avoiding collisions without requiring a hidden database. The host persists archive order/cursors for its WebSocket protocol.

Normalize unknown tool input to JSON values at the boundary. Public diagnostics serialize typed safe errors, not Error objects. Streaming deltas and final text share message identity; count tool calls by unique runtime tool-call ID, and compactions by unique boundary ID. A late/nonmatching result cannot finish another turn; retain the existing Claude prompt-UUID binder.

Retain input/output/cache-read/cache-creation semantics, including Codex's cache subtraction and cacheWriteInputTokens. Track measurement availability separately from current legacy zero defaults. Unknown usage, model, window or reset is null/unavailable, not fabricated. onTurnResult and its handle report the same completed value once.

onLimitEvent adds wait-start/wait-end variants to the existing failure signal. A retry/rate-limit observation starts a correlated wait; an actual retry resumption ends it as resumed, while stop/exit ends it as cancelled/process-ended. A reset clock or a quota percentage is not resumption. Report provider window identity/reset when known and retain null when absent.

Quota reports remain independent of turn state and do not create a synthetic turn. Preserve the existing Claude parser sources and Codex pushed/initial account report. An SDK host-login usage pull can describe a different account from a proxy session: require an explicit quota-source choice and label scope/source. Disable that fallback for headless proxy sessions unless identity is established. Optional host-supplied quota reads may provide proxy-account windows; do not invent an endpoint, borrow Kawai's account store or claim unknown proxy quotas are available.

### 7. Kawai consumption and compatibility

Add `workspaces: ["packages/*"]` and an exact workspace dependency on the runtime. `provider/createChatDriver.ts` becomes the Kawai composition adapter. It builds explicit environment/profile policy, tools, prompt, wire/audit and opaque workspace pre-submit callbacks, then constructs the package driver. Manager database/history/mailbox behavior stays in Kawai.

Retain only import re-exports and adapters at former in-tree paths, never copied driver logic or a feature flag selecting an old implementation. Manager callers must retain/observe returned promises; a void adapter must register them with its real owner, not fire-and-forget an awaitable stop. If tool-call-metrics lands first, adapt its `settled()` receipt and error ownership onto the package's stop API once; if this change lands first, tool-call-metrics adapts to the package. Either way, one stop implementation remains.

Keep Kawai's current manual/auto approval semantics, Codex on-request/user reviewer and sandbox roots, team-tool exemptions, mailbox message UUID receipts and context-before-enqueue behavior. Persisted runtime IDs/homes remain unchanged, so no database migration is proposed. Runtime wire/activity/background features needed by current Kawai must not disappear to shrink the library.

If tool-call-metrics has landed before this change, do not alter its seed, all300 History streams, all411 Links emits, faults, default timeouts/workers or source oracles. Retain recovery observations before normal cleanup; package adoption must not introduce a preserve-finalizer mode, restore a DB snapshot or delete data via manager.kill as a cleanup shortcut.

### 8. Distribution, release and access

Initial release `0.1.0`, independent of Kawai binary tags. Package tags use `agent-runtime-v<version>`, a matching manifest/changelog and immutable source commit. A breaking documented API change increments major even from 0.x. Add `.github/workflows/agent-runtime-release.yml`; it must not activate release.yml's application v* flow.

Bun reads overrides only from the consumer root. Publish the existing empty stub as `@motuslabs/claude-agent-sdk-no-cli` with a versioned package artifact, then document **all eight** platform overrides to that GitHub Packages package in Kawai/SmartFactory roots. Kawai may retain the local file form in its monorepo. Runtime dependency overrides alone are insufficient. [Bun override scope](https://bun.sh/docs/pm/overrides).

Use a clean Bun consumer to install the exact packed runtime and SDK with root overrides; inspect dependencies/tarballs for CLI binaries and Kawai paths. Test the minimum supported Bun 1.3.0 and the repository-pinned current Bun. If the chosen SDK cannot run on that minimum, fix compatibility before release rather than silently raising the user requirement. Node 22 is a documented optional matrix result.

CI PR jobs get no publication credentials. A trusted package-tag release checks tag/version, locked dependencies, package tests, tarball contents/types, Kawai build/full checks and required headless evidence before publish. Use package job permissions contents:read/packages:write and the publishing repository's GITHUB_TOKEN. Link both manifests to MotusLabs/kawai. [GitHub npm authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

An authorized package administrator grants **Read** to MotusLabs/smartfactory under **Manage Actions access** on both packages. Its trusted smoke job uses contents:read/packages:read and its own GITHUB_TOKEN. Local installs use a classic PAT with read:packages and account access; authorize organization SSO if required. Configure @motuslabs registry and an environment-expanded token in .npmrc/Bun configuration; never commit a token. [Package workflow access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

No registry credentials/access were inspected and no package exists or access grant is assumed. Current agent outbound policy excludes registry publication and package-settings mutation: prepare reviewable CI/docs, then have an authorized owner operate publication/access. That external gate is not waived by planning approval. A packed install is not proof of either registry or SmartFactory Actions access.

## Acceptance oracles

All tests below are **planned/unrun**. Read `docs/oracle-hazards.md`: test production composition, not only helpers; preserve identity on replay; exercise every launch branch and later respawn. Commit these tables verbatim as tests, with @covers annotations for each delta scenario. A result maps each row to its exact test title and killed mutant.

### Lifecycle decision table

Axes: state = unstarted/starting/idle/active/stopping/stopped/exited; operation = start/send/interrupt/stop/exit/ready/result/native, where native is runtime input that opens a turn without `send` (Claude `init`, Codex `turn/started`), e.g. after a background task ends. Valid configuration, matching current generation/turn for ready/result/native unless explicitly stale; stop includes kill/shutdown. `*` means irrelevant to the row. Rows with state sets expand to each member.

| ID | State | Operation | Observable result |
| --- | --- | --- | --- |
| L01 | unstarted | start | One initialization, no prompt; `start()` resolves at L17 (idle) or rejects with the most specific category (configuration/dependency/authentication/resume, else transport) |
| L02 | exited | start | Same saved conversation resumes; no implicit new conversation |
| L03 | starting | start | Share the current initialization |
| L04 | idle, active | start | Resolves at once as a no-op; no second process, no event, no state change |
| L05 | unstarted, exited | send | Typed not-ready refusal; no user event |
| L06 | starting | send | Await initialization, then recheck admission as if called then (L07/L08/L13); failed start rejects not-ready with the cause; stop or interrupt refuses before enqueue |
| L07 | idle | send | One message/turn handle; active turn |
| L08 | active | send | Default new-turn mode refuses busy without duplicate work |
| L09 | unstarted, idle, exited | interrupt | No-active-turn receipt; no exit claim |
| L10 | starting, active | interrupt | Cancel pending requests; active: one `turn_interrupted`, no `turn_completed`, the turn and every queued submission settle at once as interrupted, become idle, the late runtime result is L20; starting: sends awaiting L06 reject not-ready (code `interrupted`); receipt `requested` when anything was cancelled, else `no-active-turn`, never an exit claim |
| L11 | unstarted, starting, idle, active, exited | stop | Admission closes; one terminal stop promise; success only after owned exit/join; an active turn ends with `turn_interrupted` and outcome interrupted (category stopped); no `onProcessEnd` |
| L12 | stopping, stopped | stop | Same terminal outcome; no new process or duplicate result |
| L13 | stopping, stopped | start, send, interrupt | Typed stopped refusal |
| L14 | starting, idle, active | exit | Once-only `onProcessEnd` and one `error` event (transport) per generation; an active turn ends with one `turn_completed` (isError, subtype `process_ended`) and outcome process-ended; a pending `start()` rejects (L01 categories); become exited |
| L15 | stopping | exit | Continue stop join; no unexpected-exit callback |
| L16 | stopped, exited | exit | Duplicate/retired notification has no duplicate outcome |
| L17 | starting | ready | Become idle; waiting sends recheck admission |
| L18 | idle, active, stopping, stopped, exited | ready | Ignore stale completion; never reopen a stopped driver |
| L19 | active | result | Matching turn resolves once; become idle |
| L20 | starting, idle, stopping, stopped, exited | result | Unmatched/late result does not create or complete a turn |
| L24 | idle | native | One agent-started turn with the runtime's turn identity: `turn_started` with its trigger (task summaries, else resumed), no user message or handle; become active; its result (`messageUuid` null) reaches `onTurnResult` once (L19) |
| L25 | active | native | Binds to the current turn; no second `turn_started` or turn |
| L26 | starting, stopping, stopped, exited | native | Stale/early input opens no turn, emits no turn event or result, never reopens a stopped driver |

Unreachable U01: unstarted + exit; U02: unstarted + ready/result/native. No process was created, and no state returns to unstarted. Every one of the 56 state/operation pairs matches exactly one expanded row, U01 or U02. Invalid configurations are covered before this machine by P01-P04; stale identities are covered by R03/R07. Explicit continuation rows: L21 Claude queue => actual queued turn identity, FIFO, state stays active between turns (no idle in between); L22 Codex steer => same active turn result, `onTurnResult` once per turn, the result's `messageUuid` is the turn's opening message; L23 unsupported mode => typed refusal.

### Environment, permission and seam table

| ID | Inputs | Observable result |
| --- | --- | --- |
| P01 | Missing env or required home; runtime * | Configuration error; zero launches |
| P02 | Poisoned ambient credentials; explicit Anthropic OAuth env | Exact helper-returned spawn/probe env, no foreign credentials, parent unchanged |
| P03 | Proxy URL + custom header + placeholder token; hostile env/settings | Exact selected proxy values, conflicting credentials neutralized, no argv/log secret |
| P04 | Explicit Codex home + poisoned Claude env | Selected home only; no implicit host credentials on first spawn or respawn |
| P05 | Restricted Claude; tool in explicit read set | Allowed read only |
| P06 | Restricted Claude bypass; Bash/five named tools/unknown tool | Denied without execution or user wait, including after resume |
| P07 | Codex never; sandbox workspace-write/read-only/none | Exact selected protocol policy on start/resume; none maps unrestricted |
| P08 | Two sessions; different permission/profile configuration | No cross-session mutation; reapplied on resume/respawn; persisted/home settings do not broaden policy; unenforceable restriction refuses to start |
| P09 | Empty custom tools/context/wire | Headless turn works; no team tools, stores or recording |
| P10 | Known tool; wrong thread/namespace/schema or unknown name | Structured refusal, zero handler invocations |
| P11 | Valid bound tool and schema | One handler invocation and result |
| P12 | Context callback refuses/throws | No enqueue, turn-start or user-message event |
| P13 | Context callback accepts | Same minted UUID and turn id the callback recorded are enqueued, emitted and returned; Kawai display/receipt remains valid |
| P14 | Names-only observer; secret-bearing tool input | No input in observation/logs; unique identity/count retained |
| P15 | Observation hook throws; decision * | Same tool outcome, no duplicate execution or permission grant |
| P16 | Non-root, explicit cwd/home/cache/temp; optional sinks absent | No listener/tmux/server dependency or out-of-root runtime write |

### Requests, results and delivery table

| ID | Inputs | Observable result |
| --- | --- | --- |
| Q01 | Question callback answers immediately | Registered ID accepts answer once; no deadline/UI |
| Q02 | Approval callback denies immediately | Runtime gets denial once, no execution |
| Q03 | Answer races interrupt/stop; duplicate answer | One settlement; late/invalid answer reports refusal |
| Q04 | Disabled input/elicitation or missing/throwing headless handler | Immediate configured response or safe denial, no indefinite pending request |
| R01 | Successful matching turn; known usage/model/tools/compactions | Exact result and counts, same handle/callback value |
| R02 | Unauthorized vs quota vs transport/provider failure | Distinct safe error categories and failed outcome |
| R03 | Previous/nonmatching UUID result or repeated tool/boundary IDs | No wrong-turn result; no duplicate counts |
| R04 | Quota update while idle/active/request-pending | Same normalized windows/source, no synthetic turn |
| R05 | Rate wait + observed resumed retry | One correlated wait start/end with known window/reset |
| R06 | Rate wait + time passes / stop / exit | Clock alone emits no resumption; stop/exit ends once with its cause |
| R07 | JSONL round-trip, resumed stream, late frames | Stable stored IDs/order, collision-free new stream, late frames isolated |
| R08 | No usage/model/window data; proxy without known quota source | Explicit unavailable/null; no borrowed account or fabricated zero |
| R09 | Missing/malformed/valid structural Codex auth | False/false/true without values in output |
| R10 | Invalid resume target or checkpoint persistence rejection | Typed failure; no fallback fresh conversation or dependent acceptance |
| R11 | Observer/event callback throws during real result handling | Internal result/usage still settles; safe callback error, no unhandled rejection |

### Package and application table

| ID | Inputs | Observable result |
| --- | --- | --- |
| D01 | Packed ESM/types in clean Bun project, no Kawai files | Imports/typecheck/controlled turns work; no repository escape |
| D02 | Clean root install with all eight stub overrides + pinned SDK | No platform CLI binaries or install-time CLI invocation |
| D03 | Missing Claude or Codex executable | Actionable per-runtime error; other runtime/import works |
| D04 | Matching tag/version + all checks vs mismatch/failing check | Publish allowed only for matching verified commit; no PR credential exposure |
| D05 | 0.1.0 API-compatible vs breaking change | Compatible semver update vs new major and changelog migration |
| D06 | Local authorized read:packages token | Clean registry install of exact immutable version |
| D07 | SmartFactory Actions GITHUB_TOKEN + Read on both packages | Clean registry install in that repository; retained job receipt |
| D08 | Real supported CLIs and explicit homes/credentials | Both turns, interrupt, kill/actual exit/resume; callback wiring demonstrated |
| D09 | Documented example using no optional Kawai integrations | Typechecks/runs without undocumented requirements; every seam/callback documented |
| K01 | Kawai constructs both runtimes via package | Build/full suite and affected fixture e2e pass; no duplicate implementation |
| K02 | Existing Kawai manual/auto, catalogs, tools, context, audit and resume | Prior application oracles/UUIDs preserved through production composition |

### Invariants and generated properties

Use existing seeded-generator conventions, no new test framework. A deterministic model uses the lifecycle table as reference. Named boundaries are in-memory checkpoint/admission/completion boundaries, not new database transactions.

| Property | Invariant and generator | Seams, fixed seed and count |
| --- | --- | --- |
| I1 | Stop receipt never precedes actual owned process exits/JS join; varied exit, pipe-close, control and late-child order | Owned spawn + real driver; 0xA601, 300 sequences of 1..60 operations |
| I2 | A saved runtime ID resumes the same conversation; invalid/unsaved identity never silently creates one. The driver resumes any caller-supplied identity the runtime accepts; a rejected checkpoint only withholds acknowledgement of dependent work | Real query/client adapter + caller checkpoint store; 0xA602, 300 sequences, crash at each checkpoint/admission/result boundary |
| I3 | Final process/probe env equals the explicit map approved for that operation (the launch callback may return a new one per generation), parent and sibling maps unchanged | Poisoned ambient/env/home/settings combinations at actual spawn; 0xA603, 256 cases across all profile branches/respawns |
| I4 | Denied/unlisted tool never executes or gains a permission from observation | Real provider policy wiring, tool/mode/resume matrix; 0xA604, 256 cases |
| I5 | Each request settles once despite immediate answer/cancel/duplicate races | Real callback bridge and protocol client; 0xA605, 256 permutations |
| I6 | Events serialize losslessly; IDs do not collide and stale generations cannot finish current turns | Production emitter/binder with duplicated/reordered source frames; 0xA606, 300 streams |
| I7 | Results/counts/window/wait facts belong only to their actual identity; unknown remains unknown | Production parsers/reducers, interleaved turn/quota/retry frames; 0xA607, 300 streams |
| I8 | Optional integrations are inert when absent and observational failures do not change execution | Same controlled production trace with hooks absent/present/throwing; 0xA608, 128 paired traces |
| I9 | Packed consumers and Kawai reach one driver implementation with equivalent policy behavior | Export graph + production composition, varied injection/continuation cases; 0xA609, 128 cases plus D01-D09 external checks |

For I1/I2/I6, expand the lifecycle axes to assert zero gaps/overlaps. Replay commands, supersede a process generation, and crash after native ID receipt, after checkpoint commit, after submission admission and after result emission. Prove old continuations cannot write after final disposal. Do not call a cancelled callback/body a join.

Before implementation, commit an inputs-only oracle table and obtain the protocol's blind second reading from an eligible reviewer of another model family; resolve differences in the table. Then implement one real Claude/Codex process/permission boundary with its failure oracle before broad extraction. No advisor, implementation writer or native test is dispatched by this proposal.

### Blind reading resolution (task 1.3)

Reader: MiMo session `chat-4dd769ef`, a different model family from the Claude author, reading only the packet built from `57e6350f` (delta specs, inputs-only tables, contract types; checksums verified; no design). Its lifecycle and invariant outputs matched the design on every decided row. Its AMBIGUOUS marks were resolved in the table and contract, not left to implementation: start resolution and rejection category (L01/L14), repeated start (L04), sends and interrupt while starting (L06/L10), interrupted-turn events (L10), the outcome of a turn cut by stop (L11), the crash event pair (L14), queue order and state (L21), steer result count and identity (L22), the agent-started result identity (L24, a contract defect: `messageUuid` was non-null), resume after a rejected checkpoint (I2) and the per-operation map (I3). Its unreachability note moved unstarted + ready/result/native to U02. Its policy outputs (P01-P16) matched on every row; two showed the spec stating less than the design and were closed in the policy spec: persisted/home settings cannot broaden a session (P08) and an accepted submission keeps the identity the context callback recorded (P13, new scenario). P04 respawn and P06 resume were already implied by the environment and reapplication requirements.

Risk: the reading certifies spec decidability, not behavior; a wrong resolution here propagates to every driver test. Invariants touched: I1-I4. Owner: the change author; the human owner reviews the change at acceptance. Checkpoint: the 2.4 advisory review of the first real process/permission path re-reads these rows against running code.

### Coverage and effectiveness map

Planned package test files: `__tests__/lifecycle.test.ts` (L01-L26/I1-I2), `policy.test.ts` (P01-P16/I3-I4/I8), `requests.test.ts` (Q01-Q04/I5), `events.test.ts` (R03/R07/R11/I6), `usage.test.ts` (R01-R06/R08/I7), `auth.test.ts` (R02/R09), `resume.test.ts` (R10/I2), `distribution.test.ts` (D01-D05/D09/I9). The release/real-provider receipts cover D06-D08; Kawai integration tests/e2e cover K01-K02.

Requirement/scenario mapping: runtime headless => P09/D01; start/results => L01/L07/R01-R03/R08; interrupt => L09-L10; forced stop => L11-L16/I1; shutdown/resume/checkpoint => L02/R10/I2; unexpected exit => L14; agent-started turns => L24-L26 (stop during one => L11); requests => Q01-Q04; events => R07/I6; quotas/waits => R04-R06/R08; login/auth => R02/R09. Policy scenarios: poisoned host environment => P02/I3; empty or missing environment => P01; Z.AI-style proxy => P03; OAuth and Codex home => P04; different permissions => P08; attempted write or shell => P06/I4; allowed read => P05; read-only resumed thread and no sandbox => P07 (headless input/elicitation => Q04); no tools => P09; wrong identity or schema => P10-P11; no workspace context => P09; context refuses => P12; context accepts => P13; names-only observer => P14; observer throws => P15/I8; minimal container => P16. Distribution scenarios map in order to D01/K01-K02/D02-D09.

Required local controls: M-env merges ambient env; M-policy removes the deny hook or resume override; M-join substitutes iterator/kill acknowledgement for native exit; M-request emits before registration; M-bind accepts a stale UUID; M-count duplicates a call; M-wait ends from reset time; M-wire removes package/Kawai wiring; M-pack imports a Kawai module; M-native drops the production agent-started open (or opens one on idle attach/stale generation); M-release skips tag/version/check gate. Each must fail the corresponding oracle, not merely fail compilation. Use temporary test controls during future implementation and restore source; no campaign is run now.

## Risks / Trade-offs

- SDK/CLI permission or process behavior differs from current documentation -> first production-path checkpoint against exact supported versions; no release if denial/exit oracles cannot be met.
- Exact env enforcement may expose hidden SDK configuration assumptions -> test final spawn/probe map, hostile settings/homes and all respawns; surface a specific configuration error rather than inherit.
- POSIX process groups do not contain independently detached workloads -> state receipt scope; require host containment for independently launched services; do not certify workspace reuse from leader exit alone.
- Optional SDK peer/root overrides add install steps -> publish stub, copyable manifest recipe and clean-install gates; no install script rewriting consumer manifests.
- Kawai callback/policy migration can regress mailbox receipts or metrics -> retain original production-composition tests and source ownership; resolve the driver stop-path conflict with tool-call-metrics once, in whichever change lands second.
- A cached full check or fake provider is mistaken for native or registry proof -> distinct D06-D08 receipts and current clean committed-tree Kawai certificate.
- A proxy offers no authenticated quota source -> unknown quota is documented, account identity is never guessed.

## Migration Plan

1. Owner reviews this proposal; implementation requires a new apply request. Record one writer per branch/worktree and a named eligible cross-model design challenger. This proposal enrolls no coordinator pilot.
2. Start from current `origin/master`; do not import the uncommitted tool-call-metrics S1 diff. Record the base. When either change lands, the other rebases and resolves the driver stop-path conflict once.
3. Freeze API/inputs-only oracles, resolve the blind reading, implement and challenge the smallest owned-spawn/environment/permission path. If it cannot prove actual exit or deny tools, revise the mechanism before extraction.
4. Extract pure types/helpers and each driver, then wire Kawai through adapters. Land no second implementation. Add package tests to root lint/typecheck/test/check coverage and content hashes.
5. Produce/test the packed artifact and headless example. Run affected Kawai fixture e2e in a disposable checkout, isolated DB/home and spare port using the CI fixture environment; never invoke the live server teardown command.
6. Obtain real CLI lifecycle/permission/environment evidence using explicit authorized test credentials and retained homes. Keep synthetic replay results separate from actual CLI results.
7. Prepare/review package CI and README/changelog. An authorized owner publishes the pinned 0.1.0 artifacts and grants SmartFactory Read access; record exact versions/digests and the local/Actions install receipts.
8. Report API differences to Ruslan before agent-host leaves its fake driver. Roll back by reverting the consumer/package-adapter change to its previous verified commit, retaining native transcripts and saved IDs. Never delete a published version or replace its contents; fix forward with a new version.
9. Implementation final acceptance requires clean committed full checks, affected e2e, exact-head cross-model review and CI before the existing global landing process. Archive this OpenSpec change only after the released/installable behavior and required scenario coverage are established.

All acceptance above is prospective. Planning completion does not claim process settlement, runtime correctness, publication, repository access or SmartFactory compatibility.

