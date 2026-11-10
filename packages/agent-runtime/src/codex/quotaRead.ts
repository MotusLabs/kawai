// The Codex driver's one account/rateLimits/read (design §6, task 5.3): asked
// once per driver, after the first generation is ready, as owned work stop
// joins. Its reply is a `report` of the session's own login (facts.ts). A reply
// that arrives after its generation was retired or superseded reports nothing.
// An app-server that refuses or lacks the method, or a process or stop that
// closes the request first, gives no report and no failure: the read is
// optional, and an exit already reports itself. Any other throw stays owned.
// A host that shares one read between sessions of a login does so itself.
import { AgentRuntimeError } from '../errors.js'
import type { JsonObject } from '../json.js'
import { AppServerRpcError } from './appServerTransport.js'
import type { CodexFacts } from './facts.js'
import type { CodexGeneration } from './generation.js'

export interface QuotaReadHost {
  runOwned(label: string, body: () => Promise<void>): Promise<void> | null
  current(): CodexGeneration | null
  facts: Pick<CodexFacts, 'quotaRead'>
}

export function readQuota(generation: CodexGeneration, host: QuotaReadHost): void {
  void host.runOwned(`quota-read:${generation.number}`, async () => {
    let reply: unknown
    try {
      reply = await generation.transport.request('account/rateLimits/read', {} as JsonObject)
    } catch (error) {
      if (error instanceof AppServerRpcError || error instanceof AgentRuntimeError) return
      throw error
    }
    if (generation.retired || generation !== host.current()) return
    host.facts.quotaRead(reply)
  })
}
