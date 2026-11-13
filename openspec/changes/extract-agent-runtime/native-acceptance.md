# Current native verification, 2026-11-13

Task `task-350ed68e-c7d5-4f1e-836e-75b195ce5393`, contract `r4#ea5582321149`.
**R4 evidence-only deliverable; 7.4 remains incomplete.** Codex recovery produced lifecycle receipts, but the Claude forced-stop receipt, native permission execution facts and current Codex cross-host reconstruction proof remain missing. R4 authorizes inert artifact checks only, not more provider calls or a native waiver. No task checkbox changes.

## Current inputs and isolation

- Accepted source: `be6fb56d25a6dab2b9423a5875968723bba77858`; package 0.1.0, SDK 0.3.289, Bun 1.4.3 (`c6da4a4d3`), Linux uid 1000.
- Real installed CLI versions checked under isolated maps: Claude 2.1.323 and Codex 0.169.0. Codex generated protocol remains 0.163.0; this is not a claim that its newer installed CLI completed native acceptance.
- Carried only the committed cfe2 probe, guards and this historical record. Original git blobs, respectively: `f51f8896b98d4f1437405a6d58a83bfd9dc5bdd0`, `facdee119423494d78b844248e4ed27e8606758a`, `7970b0c26b577de5655784e1444c37915707f734`.
- Compared cfe2 to be6: runtime source changes only `src/claude/generations.ts`; root/package manifests and lock differ. Its all-settled generation teardown does not change the fail-closed classification of a nonzero native exit. No prior receipt or full-pass certificate is reused.
- Both host and CLI used the same explicitly checked environment and cwd in a fresh persistent private root outside git, with separate HOME/provider/cache/temp/XDG config/data/state paths. No ambient map merge or owner settings/history/conversation read. Public factories/default owned process path only.
- Selected configured `glm-flash` proxy routing via the public profile helper, requested model `sonnet`; actual result model was `claude-sonnet-5-5`. The helper drops family model-mapping variables from its base input; this result must not be presented as a `glm-5.3-flash` model run. No fallback/provider retry followed.
- Two pre-provider guard refusals are retained separately: omitted explicit provider-home after helper filtering, then Bun's undefined presentation of an empty TLS flag. Neither reached driver construction or a model. Private preparation reasserted the owned provider home and explicitly set TLS verification to `1`; the guards were not weakened.
- Raw wire/hooks/causes stay in private mode-0600 files under mode-0700 roots. No endpoint, launch map, token or owner identity is published here. Host/path checks establish explicit configuration, not a syscall audit or OS containment boundary.

## Current actual observations

| Fact | Current Claude evidence |
| --- | --- |
| Host and child | Exact explicit map verified at host entry and equals observed spawn map; one generation |
| Initial turn | Success; Read returned `native-read-cobalt`; remembered `cobalt-otter-73` |
| Permission | Read Pre/PostToolUse observed; ToolSearch PreToolUse observed and blocked; Bash unavailable, denied file absent. No direct native five-write-tool/Bash denial matrix |
| Interrupt | Actual assistant-output boundary, receipt `requested` / `processExit:false`; correlated result `interrupted` |
| Forced stop | Rejected at operation `kill`; no returned success receipt |
| Native cause | Generation 1, pid 2360743, exit code 143, signal null, `observedBeforeStop:false`; nested SDK cause `Operation aborted` |
| Cleanup | Memoized kill rejects with the same retained stop failure; host actually exits 1 |
| Separate liveness | After host exit, current owned pid absent; this is not a successful stop receipt or proof of its causal signal |
| Remaining work | R2 authorized the continuation and first Codex batch recorded below; no old native receipt promoted |

The stop rejected with `AgentRuntimeError` category `stop`, message `stop failed: 1 owned operation(s) failed`. Its nested native error is category `transport`, message `agent process generation 1 exited with code 143 after the stop began`. Full recursive private fields, including non-enumerable causes and native facts, were captured before cleanup. No native signal was reclassified and no claim repairs the historical stop or adapter failure.

Callbacks observed: 2 results, 1 checkpoint, 1 model, 2 context, 3 detailed hooks, 1 spawn; both handle results equal their callbacks. No process-end, quota, rate-limit, request or compaction callback observed. Claude quota source was explicitly `none`. No synthetic wait or extra turn induced these paths.

## R3 setup incident and narrow restoration

The earlier no-out-of-root-write claim is withdrawn: my recursive private-root permission sweep followed three Codex-created arg0 symlinks to its shared native executable and changed that target to mode 0600. This caused the recorded EACCES/SIGABRT startup; it was an author setup defect, not runtime or sandbox-policy behavior. The original failed startup receipts are retained unchanged.

The Lead restored only owner execute, 0600 to 0700, on the exact regular inode (device 66306, inode 63308667). Content remained SHA-256 `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`. The full original mode was not recorded; no restoration to 0755 is claimed. I made no shared-file repair.

R3 removes recursive chmod entirely. Private owned inputs/receipts are created as 0600 and known private directories as 0700; native artifacts keep their CLI-created modes, and symlinks are opaque. One finite owned fixture ran the exact revised setup with three aliases to an external owned regular file: mode, content and inode remained unchanged. The identical setup prepared the actual recovery input. Native recovery observations follow only after source preflight and binary identity/hash/mode checks.

## R3 corrected Codex batch

After ACK3, the one isolated version/setup preflight passed (Codex 0.169.0), and one corrected batch ran with the same configured login, model and policy. There was no further Claude call or shared-file mutation. Both shared-binary receipts agree exactly: device 66306, inode 63308667, mode 0700, SHA-256 `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`.

- Initial turn: success, actual `gpt-6-luna`; tool attempts could not read/write because real command results reported bubblewrap namespace creation was not permitted; a file-change tool also failed. This host limitation is not policy-denial proof or permission to bypass containment.
- Interrupt: actual assistant boundary; requested/processExit false; correlated interrupted result.
- Kill: actual exit 0, group cleared, JS settled; verified owned pid absent.
- Resume: native initial and resumed thread ids match the persisted checkpoint; phrase recalled. A new public driver in the same isolated host reopens the retained thread with read-only/never; this is not an extra Codex host-process reconstruction run.
- Resumed permission: outgoing thread/resume is read-only/never and turn/start is readOnly/networkAccess false. The model's refusal has zero tool calls; its prose and the absent denied file are not a demonstrated executed write denial.
- Shutdown: actual exit 0, group cleared, JS settled; verified owned pid absent. All three handle results equal their callbacks.
- Callbacks: 3 results, 1 checkpoint, 2 models, 9 context, 10 actual quota reports, 2 thread-open observations and 2 spawns. No request, process-end, limit wait or compaction callback observed. No extra turn induced one.

Remaining gaps: no successful Claude forced-stop receipt or direct native named-tool denial matrix; Codex successful initial tool execution is blocked by host namespace permissions, and causal resumed write denial is unproved. These native results authorize no additional paid call or sandbox/environment repair. R4 separately authorizes artifact-quality checks below. The earlier failed Codex startup and setup incident remain separate records.

R3 private script/receipt hashes (SHA-256):

- safe-private-setup.py: `406eddf07b2502acac25b925863576b0ae1b47dbb130f8f06306fc256ba19219`.
- r3-finite-setup-witness.py: `9d9d0511acb06f41ebe74f9548c5a2a427a1500515d4236417fc9526f4a38722`.
- r3-finite-setup-witness.log: `e501fc4d43119571755929df3f63d6235dbbf4f7e5788b858eac75f15dc148d5`.
- binary-before-r3.json: `352abd0561ebd876605e5c428b86337f7bce34ba43018c487a164c32608a6e0d`.
- binary-after-r3.json: `352abd0561ebd876605e5c428b86337f7bce34ba43018c487a164c32608a6e0d`.
- codex/private-evidence.json: `ff00fc3fe2b6eb3ccc5d9d9a87d58defd1b16410a5899696667087f0993b5bc9`.
- codex/r3-host-exit.json: `b5a7cb2fc674d663096ac5b455263fe6c29d96f15ea499bbb8f51bbcd629adee`.
- codex/r3-version.txt: `f3807264176de3c20897352ed66cf258503bb4d52bf8428b5e8a3ac21c22cdcb`.

## R2 remaining batch: actual facts and gaps

R2 was acknowledged before continuing. The original proven-owned Claude pid was independently absent before a second host started its one saved-identity resume turn. No initial Claude turn, interrupt or kill was repeated, and its model map/policy was not changed.

- Claude continuation: success, `cobalt-otter-73` recalled without reading files. Original and resumed native `system/init` ids both equal the saved checkpoint; the result equals its callback. New host/CLI maps match exactly. Shutdown returned actual exit 0, group cleared and JS settled; the owned pid was absent. This successful shutdown does not repair the failed kill.
- Claude resumed permission: the model reported no write-capable tool and no possible write attempt; no tool call or hook occurred in this turn. The denied file is absent. Model prose plus absence is not causal denial proof or the direct native named-tool denial matrix.
- Codex 0.169.0: exact isolated host map verified and one app-server generation constructed. Its Node CLI wrapper reports `process.execve failed with error code EACCES`, then native `SIGABRT` before ready. No turn or checkpoint occurred. This startup/executable failure is not policy-denial proof. R3 identified my setup permission sweep as its cause (see the incident section above).
- Codex start rejects category `transport`. Cleanup rejects category `stop`, retaining the start failure and a native failure with generation 1, pid 2390541, code null, signal `SIGABRT`, `observedBeforeStop:true`. Host exit 1 and later owned-pid absence are separate facts, not a successful receipt.
- Historical R2 preparation initially assumed a custom provider section; a credential-shape check confirmed the configured standard provider and available login instead. Only its auth file was copied, with no owner project trust, history or settings. This setup correction made no model call and introduced no endpoint or fallback provider.
- At the R2 stopping point, Codex lifecycle facts were missing. Only R3 subsequently authorized the changed-setup recovery above; the original failed startup remains failed.

R2 receipt hashes (SHA-256):

- claude/private-resume-evidence.json: `1d5244743fc75e9531571a42806a345454e99edb618ca29d9e48091a63c1dcf2`.
- claude/resume-host-exit.json: `19e52d8e5d9431bf7479929a6d7c8bc961b77716070a0893cffdaf16ce0927f1`.
- claude/resume-proof.json: `a59e651fc51b8e31d8cb1f97fc6b2a4ed34aa1295313c579bbef7e990b64fc4d`.
- codex/failed-startup-private-evidence.json: `2d1146721ce6730d0049e965c86ca93b735226b18ecfcb24e44271e0ee2682f8`.
- codex/failed-startup-host-exit.json: `12a9433736ab1bf39f5242d166b36ca0618ccbd8ebc2a27a5987b55cc626e367`.
- codex/failed-startup-post-exit-observation.json: `aa2a72e1782c329784125cc436a55b902c597f2da6f5d1dfb34f8d61603ba7be`.

## Current retained objects and hashes

```json
{
  "first": {
    "turnId": "91c81544-e3ff-497c-a17d-22a04fa94fd4",
    "messageUuid": "62efef27-fe45-401c-9385-c036664a3793",
    "outcome": "success",
    "finalText": "- **Remembered phrase:** cobalt-otter-73\n- **read-marker.txt:** read successfully (content: `native-read-cobalt`)\n- **Bash:** unavailable — no Bash tool exists in this session's toolset, and ToolSearch is disabled, so I couldn't load it. denied.txt was not written.",
    "model": "claude-sonnet-5-5",
    "usage": {
      "inputTokens": 9687,
      "outputTokens": 315,
      "cacheReadTokens": 9344,
      "cacheCreationTokens": 0
    },
    "toolCallCount": 2,
    "compactionCount": 0,
    "error": null
  },
  "interrupted": {
    "turnId": "60bd98cb-06f1-4040-906e-34c1e797d1df",
    "messageUuid": "932b0f95-a00c-4971-a4ff-c6446bd3b62a",
    "outcome": "interrupted",
    "finalText": null,
    "model": "claude-sonnet-5-5",
    "usage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "cacheReadTokens": null,
      "cacheCreationTokens": null
    },
    "toolCallCount": 0,
    "compactionCount": 0,
    "error": {
      "category": "stopped",
      "message": "the turn was interrupted"
    }
  },
  "interrupt": {
    "outcome": "requested",
    "processExit": false
  },
  "nativeFailureFacts": {
    "generation": 1,
    "pid": 2360743,
    "code": 143,
    "signal": null,
    "observedBeforeStop": false
  },
  "claudeResumed": {
    "turnId": "986c316e-12bb-4228-bfa8-3095d957ff83",
    "messageUuid": "a63a69db-44c7-4ec4-a8cf-0f4dd43161dd",
    "outcome": "success",
    "finalText": "**Phrase:** cobalt-otter-73 (recalled from this conversation, no files read)\n\n**denied-resume.txt:** not written — this session has no Bash, Write, or Edit tool available (ToolSearch is disabled, so none can be loaded), so no write attempt was possible.",
    "model": "claude-sonnet-5-5",
    "usage": {
      "inputTokens": 261,
      "outputTokens": 204,
      "cacheReadTokens": 9728,
      "cacheCreationTokens": 0
    },
    "toolCallCount": 0,
    "compactionCount": 0,
    "error": null
  },
  "claudeShutdown": {
    "scope": "agent-processes",
    "mode": "shutdown",
    "processes": [
      {
        "generation": 1,
        "state": "exited",
        "pid": 2384033,
        "code": 0,
        "signal": null,
        "escalated": false,
        "groupCleared": true
      }
    ],
    "js": "settled"
  },
  "codexStartFailure": {
    "operation": "initial-start",
    "category": "transport",
    "nativeSignal": "SIGABRT",
    "wrapperStderr": "process.execve failed with error code EACCES"
  },
  "codexCleanupNativeFacts": {
    "generation": 1,
    "pid": 2390541,
    "code": null,
    "signal": "SIGABRT",
    "observedBeforeStop": true
  },
  "codexRecovery": {
    "first": {
      "turnId": "d52aa35a-7166-4d49-8aa6-a9a6f3c456e6",
      "messageUuid": "b23c102d-802c-4859-9986-ff8bd9b6621a",
      "outcome": "success",
      "finalText": "I remember **cobalt-otter-73**. The tool couldn’t read `read-marker.txt` or write `allowed.txt`: shell access failed, and the file patch was rejected.",
      "model": "gpt-6-luna",
      "usage": {
        "inputTokens": 10258,
        "outputTokens": 411,
        "cacheReadTokens": 65280,
        "cacheCreationTokens": 0
      },
      "toolCallCount": 3,
      "compactionCount": 0,
      "error": null
    },
    "interruptedResult": {
      "turnId": "1eb58fbc-c990-4b9d-ae24-626549f5a4b2",
      "messageUuid": "90b3960e-3d1b-4aad-b981-d9c34389d786",
      "outcome": "interrupted",
      "finalText": null,
      "model": "gpt-6-luna",
      "usage": {
        "inputTokens": 1928,
        "outputTokens": 304,
        "cacheReadTokens": 16000,
        "cacheCreationTokens": 0
      },
      "toolCallCount": 0,
      "compactionCount": 0,
      "error": {
        "category": "stopped",
        "message": "the turn was interrupted"
      }
    },
    "interrupt": {
      "outcome": "requested",
      "processExit": false
    },
    "resumed": {
      "turnId": "df981f0c-9875-4657-b7fb-009b529e3421",
      "messageUuid": "0e847943-3397-4c5c-b5b6-b93cead56f5b",
      "outcome": "success",
      "finalText": "The phrase was **cobalt-otter-73**. The single write attempt failed: the read-only sandbox blocked creating `denied-resume.txt`.",
      "model": "gpt-6-luna",
      "usage": {
        "inputTokens": 1357,
        "outputTokens": 151,
        "cacheReadTokens": 84224,
        "cacheCreationTokens": 0
      },
      "toolCallCount": 0,
      "compactionCount": 0,
      "error": null
    },
    "kill": {
      "scope": "agent-processes",
      "mode": "kill",
      "processes": [
        {
          "generation": 1,
          "state": "exited",
          "pid": 2439042,
          "code": 0,
          "signal": null,
          "escalated": false,
          "groupCleared": true
        }
      ],
      "js": "settled"
    },
    "shutdown": {
      "scope": "agent-processes",
      "mode": "shutdown",
      "processes": [
        {
          "generation": 1,
          "state": "exited",
          "pid": 2442176,
          "code": 0,
          "signal": null,
          "escalated": false,
          "groupCleared": true
        }
      ],
      "js": "settled"
    }
  }
}
```

- Current Claude private-evidence.json SHA-256: `031ad7a6cd4324376fa1438f7d40da9ec4462defdb401db7d32a12ef92135614`.
- Current Claude host-exit.json SHA-256: `4085b645ca563e186fb938991ef0447e8456e7dd8efe3998f0b37aa3aad09297`.
- Current Claude post-exit-observation.json SHA-256: `d251aec76d5a3dff3880dee003ecf76bdcbfc6526a6446cec7ec216c6d6e0fb9`.
- Current Claude host.log SHA-256: `e29997f504f0711e58798abd001a62b8899b38317367e509f6f91d2e9e7655ba`.
- Executed probe SHA-256: `e94882df5332ff8b5d62886893fbf793dd394883730f63feef7b4eb513919553`.

## R4 artifact checks and reused stages

This task delivers the inert probe, guard tests and sanitized evidence on accepted `be6fb56d25a6dab2b9423a5875968723bba77858`; it does not complete 7.4 or unblock the parent native task. The final map has 42 clause/scenario/oracle rows and 18 literal citations, with native facts explicitly separated from automated guards and controlled companions. The task result records the source preflight, affected tests, stock hooks, exact committed full-properties/no-retry certificate and formal review outcome. No provider is called by those checks.

Whole-diff comparison against be6 finds only these three additions. Runtime and application source, dependencies/manifests/lock, build/release scripts/configuration, generated inputs, e2e specs/setup/fixtures and the three shipped examples are unchanged. Package build includes `src` only; its manifest explicitly lists shipped examples and excludes `native-probe.ts`. The package typecheck does include the new example and guards and runs in the new root check. Therefore accepted build/pack/private-CI stages can be reused by input equality, without treating their logs as native or current full-check receipts.

The accepted assembly result `result-f8deba20-572f-4017-bbc9-079c5b5f1440` at be6 carries stages from archive tree `3c3a37c3`, with minimum-Bun consumers rerun at R7. Retained stage log SHA-256 values:

- Root build: `648a4ad480aeb91811f5736012e4dafa112ab252e106f48138403c1c319ad4d0`.
- Package build: `d322d3553f177d10e5d923ecf204da1390cc9c5f1778aee3dd1924815a1167c7`.
- Bun 1.4.3 packed/distribution consumers (23 pass): `9f7ff38aa70303fd28aabede40567396d2cc8938e3c8d5d6f878d7f78a306cac`.
- Bun 1.3.0 consumer R7 (9 pass): `14fbdf3d97f816be7011ba33bc964fb24f6e110d2b876195528c54dd978473a9`.
- Private CI main (27 pass, 83 skipped): `dc76294c9cdc2ce1b02c561bc4a8dd032d8cd47e9abe68cfd87c16e546d88595`.
- Private CI chat fixture (67 pass): `561ca15498b64d9d426fec535d8f1a945445a342aa7c189737b447682e2fe966`.

These are reused local stage observations, not remote CI/publication/registry acceptance. The prior plan-supervision intermittent failure and the historical native/adapter failures remain qualified in the accepted assembly and historical records. No control, build, e2e or packed-install campaign is replayed here; relevant controlled companions run as ordinary affected tests.

Historical raw receipt roots and old private map are unavailable in this environment; the old hashes below are historical references, not reverified files. Historical d061 full check failed 10613/1 at unchanged adapter assertion208; its isolated 421ms pass and later finite matrix did not diagnose the cause. No old full pass exists. Historical setup unnecessarily read only top-level names from owner Claude configuration and the empty settings env-key list, without values/copy/write/use; the old Bun host inherited ambient environment. Those old audit limits are not erased by the current explicit-host check.

The remainder is the original cfe2 sanitized record, retained verbatim as history.

# Native acceptance, 2026-11-12

Task `task-d061c629-c78a-4d1c-bf3a-3f8c51205188`, contract `r1#76aef7be00a6`.
**7.4 remains incomplete.** These are actual provider observations, with the gaps below.
No task checkbox is changed. No native success is inferred from a controlled test.

## Pins and execution

- Provisional runtime base: `b2ee020983676e8505edf66e578c52a092239d8c` (U5 still under separate review).
- Package: `@motuslabs/agent-runtime` 0.1.0; SDK 0.3.289; Bun 1.4.3 (`c6da4a4d3`); Linux, uid 1000.
- Real Claude CLI 2.1.322, configured `glm-flash` proxy profile, requested `sonnet`, reported `glm-5.3-flash`.
- Real Codex CLI 0.166.0, configured `codex-luna` profile, reported `gpt-6-luna`.
- CLI floors in design: Claude 2.1.289 / Codex 0.163.0. These installed versions are newer; generated Codex protocol remains pinned to 0.163.0. This probe establishes only the observations below for these exact installed versions.
- Public entry path: `examples/native-probe.ts` → public `createClaudeDriver` / `createCodexDriver` → real SDK / app-server → default owned processes. No private seams or core changes.
- Invocation: `bun packages/agent-runtime/examples/native-probe.ts --run <private-input.json>`; no automatic live calls under import, build or tests.
- Each runtime had its own mode-0700 disposable root with separate cwd, HOME, provider home, XDG config/data/state/cache and temp directories. Complete child environments were constructed explicitly; no ambient credential inheritance.
- Claude used only the configured proxy routing and a placeholder token; Codex received a private copy of the configured login, with project trust/UI/history settings omitted. No owner conversations, tools, settings or projects were copied. No live Kawai service was contacted.
- Optional wire/audit capture went only into private mode-0600 files outside git. Public evidence uses allowlisted fields; no launch map, endpoint, header, account identity or credential is included.
- Three tiny model turns per CLI: initial read/permission/remember, interrupt after first native assistant output, resume recall/permission. Claude resume ran in a second host process after its original pid was confirmed absent; it did not rerun the failed stop or paid initial turns.
- The first probe run preceded addition of the explicit `resume` input and nested private error capture. Its initial lifecycle branch is preserved in the committed probe. Claude continuation used the explicit resume branch. No native-relevant runtime input changed between these runs.

## Actual lifecycle and permission observations

| Fact | Claude | Codex |
| --- | --- | --- |
| Initial turn | Success; Read returned `native-read-cobalt` | Success; shell attempts failed with host namespace error |
| Interrupt | First assistant output observed; requested / processExit false; interrupted result | First assistant output observed; requested / processExit false; interrupted result |
| Forced stop | **Rejected**, `stop failed: 1 owned operation(s) failed`; wire exit code 143, signal null; pid confirmed absent before resume; no public receipt returned | Kill receipt: actual exit code 0, groupCleared true, js settled; pid absent |
| Resume | Same native session id in initial and resumed system/init frames; recalled `cobalt-otter-73` without reading files | Same thread id in both native thread replies and thread-open callbacks; recalled phrase |
| Resumed stop | Shutdown receipt: actual exit code 0, groupCleared true, js settled; pid absent | Shutdown receipt: actual exit code 0, groupCleared true, js settled; pid absent |
| Permission | Bypass/read-only tool set; Read succeeded, ToolSearch denied by hook on first and resumed turns; Bash/write tools unavailable; denied files absent | Initial workspace-write/never → resume read-only/never → turn readOnly/networkAccess false, all observed in outgoing native protocol; denied file absent |
| Missing proof | No successful forced-stop receipt; no direct native Bash/five-write-tool denial matrix | Host denied shell namespace creation before tool execution; resumed refusal text had no tool_call event, so no causal native read-only write denial proof |

The Claude exit 143 is deliberately not reinterpreted as an owned signal success. The runtime's existing fail-closed verdict distinguishes a trapped/nonzero exit from a confirmed owned signal. Its first stop error retains that distinction; a successful later shutdown does not repair the missing kill receipt.

## Retained real turn results and receipts

The following are allowlisted actual objects, not fixture outputs. Local probe-generated ids and pids are retained as correlation facts.

```json
{"label": "claude first", "observed": {"turnId": "35b320d4-82f5-4db3-8ddc-026b66578945", "messageUuid": "8dcd4329-4a46-469a-bd97-2dc9c0af5cc2", "outcome": "success", "finalText": "**Remembered phrase:** cobalt-otter-73\n\n**Tool outcomes:**\n- **Read** (read-marker.txt) — succeeded; contents: `native-read-cobalt`\n- **Bash** — unavailable: no Bash tool exists in this session (not in the active or deferred tool list; my ToolSearch attempt to load it was blocked with \"ToolSearch is not enabled for this session\"). So denied.txt was **not** written.", "model": "glm-5.3-flash", "usage": {"inputTokens": 18591, "outputTokens": 589, "cacheReadTokens": 512, "cacheCreationTokens": 0}, "toolCallCount": 2, "compactionCount": 0, "error": null}}
{"label": "claude interrupted", "observed": {"turnId": "220b2b43-a3f6-4f0a-a260-9dec92969b55", "messageUuid": "a0752e93-6998-457d-9bad-207bdaad1ed1", "outcome": "interrupted", "finalText": null, "model": "glm-5.3-flash", "usage": {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": null, "cacheCreationTokens": null}, "toolCallCount": 0, "compactionCount": 0, "error": {"category": "stopped", "message": "the turn was interrupted"}}}
{"label": "claude resumed", "observed": {"turnId": "a491789b-6dd0-4855-9891-8e0f7f32f167", "messageUuid": "dfede676-97b0-4fa3-ba42-596e84970939", "outcome": "success", "finalText": "**Phrase:** cobalt-otter-73\n\n**Write attempt:** failed — I have no write-capable tool in this session (no Bash, no Write/Edit; ToolSearch, the only way to load deferred tools, is blocked by a hook, and none of the deferred tools write local files anyway). So **denied-resume.txt was not created**.", "model": "glm-5.3-flash", "usage": {"inputTokens": 1159, "outputTokens": 640, "cacheReadTokens": 20544, "cacheCreationTokens": 0}, "toolCallCount": 1, "compactionCount": 0, "error": null}}
{"label": "claude shutdown", "observed": {"scope": "agent-processes", "mode": "shutdown", "processes": [{"generation": 1, "state": "exited", "pid": 1225369, "code": 0, "signal": null, "escalated": false, "groupCleared": true}], "js": "settled"}}
{"label": "codex first", "observed": {"turnId": "9ff594e6-1543-4a00-a8a5-dcce0db7243b", "messageUuid": "95b58d50-813f-4102-bcec-9da3cd64831f", "outcome": "success", "finalText": "Remembered: **cobalt-otter-73**. Reading `read-marker.txt` failed because the shell tool could not create its sandbox namespace; writing `allowed.txt` also failed.", "model": "gpt-6-luna", "usage": {"inputTokens": 13569, "outputTokens": 339, "cacheReadTokens": 109440, "cacheCreationTokens": 0}, "toolCallCount": 3, "compactionCount": 0, "error": null}}
{"label": "codex interrupted", "observed": {"turnId": "27b22ebd-8e5f-49ed-b104-003c60c39695", "messageUuid": "157bf59d-169b-4e9d-8408-ca75f0c8757a", "outcome": "interrupted", "finalText": null, "model": "gpt-6-luna", "usage": null, "toolCallCount": 0, "compactionCount": 0, "error": {"category": "stopped", "message": "the turn was interrupted"}}}
{"label": "codex kill", "observed": {"scope": "agent-processes", "mode": "kill", "processes": [{"generation": 1, "state": "exited", "pid": 1205860, "code": 0, "signal": null, "escalated": false, "groupCleared": true}], "js": "settled"}}
{"label": "codex resumed", "observed": {"turnId": "34aab442-404d-493d-b125-5d0bd8191a96", "messageUuid": "5e0fd0c5-cbdb-4de1-87af-45d61e2ba00f", "outcome": "success", "finalText": "The phrase was **cobalt-otter-73**. The write attempt failed: the sandbox is read-only.", "model": "gpt-6-luna", "usage": {"inputTokens": 1424, "outputTokens": 104, "cacheReadTokens": 51584, "cacheCreationTokens": 0}, "toolCallCount": 0, "compactionCount": 0, "error": null}}
{"label": "codex shutdown", "observed": {"scope": "agent-processes", "mode": "shutdown", "processes": [{"generation": 1, "state": "exited", "pid": 1211409, "code": 0, "signal": null, "escalated": false, "groupCleared": true}], "js": "settled"}}
```

## Observed callbacks and unavailable facts

- Claude: 3 result callbacks, 2 model callbacks, 4 context callbacks, 4 detailed tool hooks, 1 persisted checkpoint. Quota source was explicitly `none`; zero quota or limit callbacks were observed. No host-account pull was attempted.
- Codex: 3 result callbacks, 2 model callbacks, 9 context callbacks, 10 quota reports, 2 thread-open callbacks and 1 persisted checkpoint. Quota reports came from the real configured login/app-server, not a simulated reset.
- Neither provider produced a rate-limit wait/resume, compaction, or interactive request during these short runs. Callback absence is an observation, not proof that those paths work natively. Controlled callback oracles remain separate. No extra paid turns were used to induce quota exhaustion.
- Native scope remains incomplete for the missing Claude forced-stop receipt and the permission execution gaps above. P16 proves explicit launch path configuration and observed owned process cleanup, not an OS containment boundary or a complete filesystem syscall audit.

Private evidence SHA-256 (private roots and launch files are deliberately omitted):

- claude/private-evidence.json: `3ac3ad3009b1e95cff10919af5a831773def9a95488ce574977e4fab23f72b65`
- claude/private-resume-evidence.json: `3bf16300d174417223b41f7c22f603cc7deccf7d9f77e58b2ee502febeca707f`
- codex/private-evidence.json: `6ae925e46e623bd3cbdc69a533c72da76a6d6d3ae7f54973f4ec5278062742c2`

## Controlled companions and guard verification (separate from native facts)

The affected run passed 69 tests across six files on Bun 1.4.3. Runtime source and all pre-existing companion inputs are byte-identical to provisional base `b2ee020983676e8505edf66e578c52a092239d8c`; this batch adds only the probe, its guard tests and this record. No prior review acceptance is inherited.

- M-join boundary: `packages/agent-runtime/__tests__/ownedProcess.test.ts` › `terminate stays pending while a SIGTERM-ignoring child is alive, then escalates`.
- M-policy Claude wiring: `packages/agent-runtime/__tests__/permissions.test.ts` › `P05/P06/I4: bypass mode denies writes, Bash and unknown tools without executing; the read runs; respawn reapplies it` (actual SDK composition over a controlled CLI).
- M-policy Codex resume: `packages/agent-runtime/__tests__/codexPermissions.test.ts` › `P07/I4: a resumed thread takes the supplied read-only/never policy, not the stored broader one`.
- Native exit-143 classification companion: `packages/agent-runtime/__tests__/claudeNativeStop.test.ts` › `O4: a CLI that traps the owned SIGTERM and exits 3 is an unknown end; the stop fails`.
- `nativeAcceptance.test.ts` checks non-root isolated paths, missing/escaping/symlink paths, inert import and actual receipt liveness requirements without provider usage. Removing the uid-0 guard and removing the live-pid check each caused its intended test to fail; both protections were restored. These mutations apply only to new probe guards, never provider policy or core code.

## Reproduction and limits

Prepare a private JSON `NativeInput` with explicit configured model, executable and launch map; create every writable path below a fresh mode-0700 disposable root. `HOME`, provider home, XDG cache/config/data/state and temp must all be explicit. Keep copied login and launch files mode 0600. Do not put private files under the repository or print their environment. `settings`, when used, must contain only non-secret flag-layer settings. Invoke the probe explicitly using the command above. Review private evidence locally before copying any allowlisted fact into public evidence.

An explicit `resume` checkpoint permits only the remaining resume turn, useful after a failed stop whose real owned process was independently confirmed gone. It is not an automatic retry or fallback. `sameIdentity` is a convenience host check; the actual resume evidence here additionally compares the native session/thread identities and recalled phrase.

The root guard verifies configured paths and symlink containment, not arbitrary tools' filesystem access. Only probe-owned processes were signalled by runtime stop. No package/core/API, shared design/tasks/README, runner, manifest, lockfile, publication or live-service changes are included. Newer runtime integration pins must audit native-relevant inputs before reusing these observations.
