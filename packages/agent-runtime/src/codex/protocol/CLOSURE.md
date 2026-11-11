# Provenance of this folder

These files are a byte-identical copy of part of Kawai's committed
`src/server/chat/codex/protocol/` folder at commit `2b2d2255` (origin/master),
which `codex app-server generate-ts --experimental` generated from codex-cli
0.163.0 (`VERSION`). `README.md` is that folder's own README, unchanged, so
its paths name Kawai's tree. Nothing here was regenerated or edited.

The copy is the import closure of the types the driver's wire boundary
(`../protocolBoundary.ts`) checks against, and nothing else:

- `serde_json/JsonValue`
- `v2/CodexErrorInfo`, `v2/DynamicToolCallParams`,
  `v2/DynamicToolCallResponse`, `v2/DynamicToolSpec`,
  `v2/McpServerElicitationRequestParams`,
  `v2/McpServerElicitationRequestResponse`, `v2/RateLimitSnapshot`,
  `v2/ThreadItem`, `v2/ThreadTokenUsage`, `v2/TokenUsageBreakdown`, `v2/Turn`

and every file those import, 88 type files in all. `package.json` (added
here, `{"type":"commonjs"}`) lets NodeNext resolve the generated
extensionless imports when the package is typechecked. The emitted copies
are internal: no export of the package reaches them.

To move to another codex-cli version: copy the same closure from Kawai's
regenerated folder, update `VERSION`, rerun typecheck (the boundary checks
fail on drift) and the Codex driver tests.
