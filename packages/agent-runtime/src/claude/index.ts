// The `./claude` entry: the Claude driver factory and its permission helpers.
// Importing it loads no SDK; the optional peer is imported at start().
export { createClaudeDriver } from './driver.js'
export { RESTRICTED_CLAUDE_PERMISSIONS, RESTRICTED_DENIED_TOOLS, RESTRICTED_READ_TOOLS } from './permissions.js'
