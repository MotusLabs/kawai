# @motuslabs/claude-agent-sdk-no-cli

An empty, versioned package for the eight consumer-root overrides documented
in `@motuslabs/agent-runtime`. It contains no executable, dependencies,
exports or installation hooks. It does not implement the SDK or CLI.

Install Claude Code separately and supply its executable path to the runtime.
Bun reads overrides from the consuming application's root manifest; overrides
in a dependency do not propagate. See the runtime README for the complete
installation and GitHub Packages access recipe.

Version 0.1.0 accompanies agent-runtime 0.1.0 and SDK 0.3.289. Publication
and registry access remain owner-operated acceptance steps.
