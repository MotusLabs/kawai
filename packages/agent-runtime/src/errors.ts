// Typed, serializable runtime errors (design §2, §6). Public diagnostics
// carry an AgentErrorInfo value, never an Error object or a launch secret;
// AgentRuntimeError is the thrown/rejected form of the same value.

export type AgentErrorCategory =
  /** Missing/invalid launch configuration, detected before any spawn (P01). */
  | 'configuration'
  /** A required peer dependency or executable is unavailable (D03). */
  | 'dependency'
  /** The provider refused the credentials (R02). */
  | 'authentication'
  /** An account/plan quota was exhausted (R02). */
  | 'quota'
  /** A rate-limit or overload refusal (R02). */
  | 'rate-limit'
  /** Process, pipe or protocol transport failure (R02). */
  | 'transport'
  /** Any other failure the provider reported for a turn. */
  | 'provider'
  /** The driver is not ready to accept the operation (L05). */
  | 'not-ready'
  /** The driver is stopping or stopped (L13). */
  | 'stopped'
  /** A new turn was submitted while one is active (L08). */
  | 'busy'
  /** The requested capability or continuation mode is unsupported (L23). */
  | 'unsupported'
  /** A supplied resume identity was refused or its transcript is missing (R10). */
  | 'resume'
  /** The caller's checkpoint persistence rejected (R10). */
  | 'checkpoint'
  /** The caller's pre-submit context callback refused or threw (P12). */
  | 'context'
  /** Owned stop/join could not be established or a cleanup step failed (I1). */
  | 'stop'
  /** A defect inside the runtime. */
  | 'internal'

/** The serializable form of every runtime error. */
export interface AgentErrorInfo {
  category: AgentErrorCategory
  /** Safe, human-readable text: never a credential, header or full environment. */
  message: string
  /** A provider- or runtime-specific code when one is known. */
  code?: string
}

export class AgentRuntimeError extends Error {
  readonly category: AgentErrorCategory
  readonly code: string | undefined
  /** Original failures retained for the owner (body and cleanup errors alike). */
  readonly causes: readonly unknown[]

  constructor(info: AgentErrorInfo, causes: readonly unknown[] = []) {
    super(info.message)
    this.name = 'AgentRuntimeError'
    this.category = info.category
    this.code = info.code
    this.causes = causes
  }

  toJSON(): AgentErrorInfo {
    return this.code === undefined
      ? { category: this.category, message: this.message }
      : { category: this.category, message: this.message, code: this.code }
  }
}
