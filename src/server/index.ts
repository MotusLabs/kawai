// Server entry point. Importing this module boots the server: startServer()
// in ./bootstrap is the composition root that constructs every subsystem and
// opens Bun.serve (boot-on-import is kept so `bun src/server/index.ts` and
// the isolated harness's cache-busting re-import both start a fresh server;
// split-server-index design D1).
import { startServer } from './bootstrap'

startServer()
