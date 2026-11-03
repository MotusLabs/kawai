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
