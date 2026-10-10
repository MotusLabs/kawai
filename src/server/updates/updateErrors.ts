// updateErrors.ts - named failures for the update install path. The spec
// requires refusals to carry a name the UI can show ("an error naming the
// unexpected layout", "naming the missing checksum"), so every deliberate
// refusal throws UpdateError with a stable code and a human sentence.

export type UpdateErrorCode =
  | 'ERR_UPDATE_UNEXPECTED_LAYOUT'
  | 'ERR_UPDATE_UNSUPPORTED_PLATFORM'
  | 'ERR_UPDATE_DOWNLOAD'
  | 'ERR_UPDATE_CHECKSUM_MISSING'
  | 'ERR_UPDATE_CHECKSUM_MISMATCH'
  | 'ERR_UPDATE_TARBALL_EXTRACT'
  | 'ERR_UPDATE_SWAP_FAILED'

export class UpdateError extends Error {
  readonly code: UpdateErrorCode

  constructor(code: UpdateErrorCode, message: string) {
    // The code rides in the message too: one string is what logs, tests, and
    // the update panel all end up showing.
    super(`${code}: ${message}`)
    this.name = 'UpdateError'
    this.code = code
  }
}
