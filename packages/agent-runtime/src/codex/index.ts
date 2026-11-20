// The `./codex` entry: the Codex driver factory and the structural login
// check, and the capacity continuation input a transcript reader recognizes.
// Importing it spawns nothing and loads no SDK.
export { createCodexDriver } from './driver.js'
export { hasCodexLogin } from './auth.js'
export { CODEX_CAPACITY_CONTINUATION, CODEX_CAPACITY_CONTINUATION_VERSION, isCodexCapacityContinuation } from './continuation.js'
