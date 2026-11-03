# Proposal

## Why

SmartFactory needs Kawai's proven Claude and Codex drivers in a headless Bun daemon. A shared, versioned package lets both applications use the same implementation while keeping Kawai's server, team policies and persistence outside the runtime.

## What Changes

- Extract `@motuslabs/agent-runtime` as an ESM package with TypeScript declarations, targeting Bun >=1.3.0. Node 22 remains optional.
- Publish a small public driver contract: start, turn submission and results, cooperative interrupt, awaited forced stop, resumable shutdown, immediate request callbacks, ordered JSON events, usage, compaction and quota signals.
- Inject logger, tools (including an empty set), prompt append, optional context and wire/audit hooks, executable paths and the complete child environment. Resolve Kawai catalogs, secrets, team envelopes and plan context in Kawai adapters.
- Add explicit per-session Claude and Codex permissions. The first restricted Claude profile denies Bash entirely; bypass mode alone is not a tool allow-list.
- Retain the no-CLI SDK override. Publish the existing empty stub as a companion package and document consumer-root overrides; dependency overrides do not propagate from this library.
- Make Kawai import the package by name through its workspace dependency, with no second driver implementation. Verify a packed artifact independently of the workspace.
- Add an independent semver/changelog and GitHub Packages release workflow, plus clean-install and SmartFactory Actions acceptance. Package access and the first publication require actual external receipts.
- **BREAKING for direct driver consumers:** proposed awaited lifecycle methods and turn handles replace fire-and-forget calls. Kawai retains its existing application behavior through adapters. No existing published runtime package API is assumed.

## Capabilities

### New Capabilities

- `agent-runtime`: reusable driver lifecycle, process-stop evidence, durable resume identity, request handling, events and turn/usage results.
- `agent-runtime-policy`: explicit process environments, permission enforcement, injected tools and host integrations.
- `agent-runtime-distribution`: versioned ESM distribution, CLI exclusion, Kawai consumption, release and consumer installation.

### Modified Capabilities

None. Existing Kawai chat, profile, approval, mailbox, audit and history requirements remain binding; application-specific behavior stays in adapters.

## Impact

Implementation would add `packages/agent-runtime/`, retain `packages/claude-agent-sdk-no-cli/`, and change chat composition, shared runtime types, dependency/build configuration and package CI. It does not add an agent-host, Temporal workflow, credential store, database schema, listener or Kubernetes deployment.

The source baseline is `origin/master` at `6ee6bea8`. Concurrent tool-call-metrics work touches the same driver contract: reconcile its accepted internal JavaScript settlement work before extraction; that work does not establish native process exit. Keep one writer per overlapping worktree.

This change is a proposal only. Implementation, real-provider checks, publication and package-access configuration are not performed by this workflow. The first release is blocked until the specified environment, permission, process-exit, Kawai-regression and installation oracles pass.

