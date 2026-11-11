// The Codex driver's optional account/rateLimits/read (design §6, task 5.3):
// asked once per driver after the first generation is ready, or for each ready
// generation the caller's claimRateLimitsRead permits (session.ts), as owned
// work stop joins. Its reply is a `report` of the session's own login (facts.ts). A reply
// that arrives after its generation was retired or superseded reports nothing.
// An app-server that refuses or lacks the method, or a process or stop that
// closes the request first, gives no report and no failure: the read is
// optional, and an exit already reports itself. Any other throw stays owned.
// onQuotaNoData (R2) reports a read that was sent while its generation was
// current and answered nothing usable: an RPC refusal (a missing method), a
// reply with no windows, or an unexpected throw (then retained too). A
// process exit or stop that closed the request is cancellation, not no-data,
// and a reply after its generation was superseded reports nothing.
// A host that shares one read between sessions of a login does so itself,
// through the claim; the package keeps no store of claims or accounts.
import { AgentRuntimeError } from '../errors.js'
import type { JsonObject } from '../json.js'
import { AppServerRpcError } from './appServerTransport.js'
import type { CodexFacts } from './facts.js'
import type { CodexGeneration } from './generation.js'

export interface QuotaReadHost {
  runOwned(label: string, body: () => Promise<void>): Promise<void> | null
  current(): CodexGeneration | null
  facts: Pick<CodexFacts, 'quotaRead'>
  /** onQuotaNoData's report for this session's login. */
  noData(): void
}

export interface QuotaClaimHost extends QuotaReadHost {
  /** The caller's claimRateLimitsRead, if supplied. */
  claim: (() => boolean) | undefined
  /** Without a claim: true only for the driver's first read, which it marks requested. */
  firstRead(): boolean
  notify(name: string, callback: () => void): void
  stopBegun(): boolean
}

/**
 * A ready generation's optional read. Omitted claim: once per driver. A
 * supplied claim is asked once for this generation, only while it is still
 * current and not stopping (one that exited during its checkpoint is never
 * asked), and only `true` permits the read; a throw denies it and stays an
 * owned failure the stop reports (host.notify). A claim that stopped the
 * driver or superseded this generation permits nothing for it.
 */
export function claimQuotaRead(generation: CodexGeneration, host: QuotaClaimHost): void {
  const claim = host.claim
  if (!claim) {
    if (!host.firstRead()) return
  } else {
    if (!eligible(generation, host)) return
    let permitted = false
    host.notify('claimRateLimitsRead', () => void (permitted = claim() === true))
    if (!permitted || !eligible(generation, host)) return
  }
  readQuota(generation, host)
}

const eligible = (generation: CodexGeneration, host: QuotaClaimHost): boolean => !generation.retired && generation === host.current() && !host.stopBegun()

export function readQuota(generation: CodexGeneration, host: QuotaReadHost): void {
  void host.runOwned(`quota-read:${generation.number}`, async () => {
    const live = () => !generation.retired && generation === host.current()
    let reply: unknown
    try {
      reply = await generation.transport.request('account/rateLimits/read', {} as JsonObject)
    } catch (error) {
      if (error instanceof AgentRuntimeError) return
      if (live()) host.noData()
      if (error instanceof AppServerRpcError) return
      throw error
    }
    if (!live()) return
    if (!host.facts.quotaRead(reply)) host.noData()
  })
}
