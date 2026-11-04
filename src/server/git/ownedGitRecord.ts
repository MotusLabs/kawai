// Internal S4 custody/evidence policy; no admission or application lifetime.
import type { GitResultFrame } from './ownedGitProtocol';

export type OwnedReason =
  | 'spawn' | 'timeout' | 'capture' | 'unsupported-platform' | 'startup' | 'executable'
  | 'handshake' | 'protocol' | 'owner-lost' | 'group-present' | 'permission' | 'observation'
  | 'join-grace' | 'capture-grace' | 'resource-disposal' | 'git-signal';
export interface OwnedCleanupDetails {
  outcome: 'complete' | 'failed';
  reason: OwnedReason | null;
  ownerJoined: boolean;
  captures: 'not-started' | 'complete' | 'cancelled' | 'pending';
  joinPending: boolean;
}
interface FrozenResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureOrigin?: 'spawn' | 'timeout' | 'capture';
  readonly cleanup: 'proved' | 'unknown';
  readonly cleanupDetails: Readonly<OwnedCleanupDetails>;
}
export interface OwnedRecord {
  phase: 'pre-spawn' | 'spawn-invoked' | 'owner-valid' | 'running' | 'releasing' | 'settled';
  invoked: boolean;
  handle?: Pick<Bun.Subprocess, 'pid' | 'stdio' | 'exited' | 'exitCode' | 'signalCode'>;
  pid?: number;
  joined: boolean;
  ownerExited: boolean;
  joinWatching: boolean;
  errors: unknown[];
  expectedExit: boolean;
  hello: boolean;
  started: boolean;
  runSent: boolean;
  closing: boolean;
  finalSent: boolean;
  tuple?: GitResultFrame;
  timeout: boolean;
  spawnFault: boolean;
  captureFault: boolean;
  local?: OwnedReason;
  fault?: 'handshake' | 'protocol' | 'owner-lost';
  disposalFault: boolean;
  graceExpired: boolean;
  capturesStarted: boolean;
  terminal: [boolean, boolean];
  eof: [boolean, boolean];
  cancelled: [boolean, boolean];
  output: [string, string];
  bound: number;
  statusTerminal: boolean;
  root?: { readonly cwd: string; dispose(): void };
  rootDisposed: boolean;
  rootFailed: boolean;
  rawFds: Set<number>;
  uncertainFd: boolean;
  uncertainFds: Set<number>;
  resources: { closed: boolean; close(): void }[];
  waiters: Promise<unknown>[];
  timers: Set<ReturnType<typeof setTimeout>>;
  actions: number;
  physicalReady: boolean;
  queryUsed: boolean;
  queryReason?: 'group-present' | 'permission' | 'observation';
  retired: boolean;
  events: Set<'owner' | 'stdout' | 'stderr' | 'status'>;
  result?: FrozenResult;
}
export function createRecord(bound: number): OwnedRecord {
  return {
    phase: 'pre-spawn', invoked: false, joined: false, ownerExited: false, joinWatching: false, errors: [], expectedExit: false,
    hello: false, started: false, runSent: false, closing: false, finalSent: false,
    timeout: false, spawnFault: false, captureFault: false, disposalFault: false, graceExpired: false,
    capturesStarted: false, terminal: [false, false], eof: [false, false],
    cancelled: [false, false], output: ['', ''], bound, statusTerminal: false,
    rootDisposed: true, rootFailed: false, rawFds: new Set(), uncertainFd: false, uncertainFds: new Set(),
    resources: [], waiters: [], timers: new Set(), actions: 0, physicalReady: false,
    queryUsed: false, retired: false, events: new Set(),
  };
}
function captures(r: OwnedRecord): OwnedCleanupDetails['captures'] {
  if (!r.capturesStarted) return 'not-started';
  if (!r.terminal.every(Boolean)) return 'pending';
  return r.eof.every(Boolean) && !r.cancelled.some(Boolean) && !r.captureFault ? 'complete' : 'cancelled';
}
function reason(r: OwnedRecord): OwnedReason | undefined {
  if (r.timeout) return 'timeout';
  if (r.spawnFault) return 'spawn';
  if (r.local) return r.local;
  if (r.captureFault) return 'capture';
  if (r.fault) return r.fault;
  if (r.graceExpired && !r.joined) return 'join-grace';
  if (r.graceExpired && !r.terminal.every(Boolean)) return 'capture-grace';
  if (r.disposalFault || !r.physicalReady) return 'resource-disposal';
  if (r.tuple?.signal !== null && r.tuple !== undefined) return 'git-signal';
  return r.queryReason;
}
function eligible(r: OwnedRecord): boolean {
  return r.pid !== undefined && r.joined && r.terminal.every(Boolean) && r.physicalReady;
}
function observe(r: OwnedRecord, query: (pid: number) => void): void {
  if (r.queryUsed || !eligible(r) || r.pid === undefined) return;
  r.queryUsed = true;
  try {
    query(r.pid);
    r.queryReason = 'group-present';
  } catch (error) {
    r.errors.push(error);
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ESRCH') r.retired = true;
    else r.queryReason = code === 'EPERM' ? 'permission' : 'observation';
  }
}
export function settleRecord(r: OwnedRecord, query: (pid: number) => void): FrozenResult {
  const ordinary = r.tuple !== undefined && r.tuple.signal === null;
  const normal = r.hello && r.started && r.closing && r.finalSent && r.expectedExit
    && r.statusTerminal && captures(r) === 'complete' && ordinary && reason(r) === undefined;
  if (!r.invoked) r.retired = r.physicalReady;
  else observe(r, query); // Adverse observation retires resources only.
  const proved = normal && r.retired;
  const failureOrigin = r.timeout ? 'timeout' : r.spawnFault ? 'spawn' : r.captureFault ? 'capture' : undefined;
  const clip = (text: string) => text.length > r.bound ? text.slice(0, r.bound) : text;
  const details: OwnedCleanupDetails = {
    outcome: proved ? 'complete' : 'failed',
    reason: proved ? null : reason(r) ?? 'protocol',
    ownerJoined: r.joined,
    captures: captures(r),
    joinPending: r.invoked && !r.joined,
  };
  r.phase = 'settled';
  r.result = Object.freeze({
    ok: r.tuple?.code === 0,
    exitCode: r.tuple?.code ?? null,
    stdout: r.captureFault ? '' : clip(r.output[0]),
    stderr: r.captureFault ? '' : clip(r.output[1]),
    ...(failureOrigin !== undefined ? { failureOrigin } : {}),
    cleanup: proved ? 'proved' : 'unknown',
    cleanupDetails: Object.freeze(details),
  });
  return r.result;
}
export function lateAttempt(
  r: OwnedRecord, source: 'owner' | 'stdout' | 'stderr' | 'status', query: (pid: number) => void,
): void {
  if (r.events.has(source)) return;
  r.events.add(source);
  if (r.result) observe(r, query);
  // Disposal/actions/timers never call this function. Once all terminal
  // sources are spent, later disposal cannot manufacture a query trigger.
}
