# Proposal

## Why

Every Kawai instance currently uses the browser title `Kawai`, making tabs for different projects difficult to distinguish. Putting the instance's workspace name first makes the project visible even when tab titles are truncated.

## What Changes

- Set the browser title to `<workspace name> - Kawai`, for example `anime-studio - Kawai`.
- Derive the workspace name from the server-configured default project directory, falling back to the server working directory; use the directory's final non-empty path component.
- Keep `Kawai` as the fallback before server information arrives or when no directory name is available.
- Keep the instance title stable across session selection and navigation, and refresh it when server information is refreshed on reconnect.

## Capabilities

### New Capabilities

- `instance-identity`: Identify the running Kawai instance in the browser title using its server workspace directory.

### Modified Capabilities

None. Existing `workspace-navigation` covers discovered repositories and session navigation rather than the identity of the server instance.

## Impact

The client app's existing `/api/server-info` fetch and document-title lifecycle are affected. Existing `defaultProjectDir` and `cwd` fields suffice; no API change, new setting, dependency, or server mutation is needed. The static HTML title remains the loading fallback. This change is independent of the broader `rename-agentboard-to-kawai` change, since the HTML already uses `Kawai`.
