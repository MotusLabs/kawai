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
