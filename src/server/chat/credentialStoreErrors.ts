// Credential-store error surface: the single defining module for the fixed
// error class and its typed codes. The facade module (credentialStore.ts)
// re-exports these unchanged, so every consumer keeps the same class
// identity and code vocabulary — extracted from credentialStore.ts verbatim
// (M6 of the provider-relay-setup design).

/** Fixed safe reasons — never a value, prefix, length, parser message, or cause. */
export type CredentialFailureReason =
  | 'missing' | 'malformed' | 'unreadable' | 'unsafe-permissions'
  | 'symlink' | 'not-regular-file' | 'foreign-owner' | 'identity-changed'

export type CredentialRefusalCode =
  | 'invalid-path' | 'invalid-name' | 'name-not-catalog' | 'invalid-kind'
  | 'invalid-value' | 'value-nul' | 'retain-collaborator-required'
  | 'retain-collaborator-failed' | 'write-failed'

export type CredentialStoreCode = CredentialFailureReason | CredentialRefusalCode

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreCode
  constructor(code: CredentialStoreCode) {
    super(`credential store: ${code}`)
    this.name = 'CredentialStoreError'
    this.code = code
  }
}

export const malformed = (): never => {
  throw new CredentialStoreError('malformed')
}
