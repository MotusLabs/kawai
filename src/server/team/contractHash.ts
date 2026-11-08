// Contract hashing (implementation-contract design D2): sha256 over the
// shared canonical inputs. A contract's hash is stored with its revision;
// a revision without a contract gets a text identity computed on read from
// its direction and acceptance, never stored (I4: no backfill).
import { createHash } from 'node:crypto'
import { contractHashInput, revisionIdentity, textIdentityInput, type ImplementationContract } from '../../shared/implementationContract'

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex')

export function contractHash(contract: ImplementationContract): string {
  return sha256(contractHashInput(contract))
}

export function textHash(direction: string, acceptance: string | null): string {
  return sha256(textIdentityInput(direction, acceptance))
}

/** A revision's identity: its contract's when it has one, else its text's. */
export function identityOf(revision: { revision: number; direction: string; acceptance: string | null; contractHash: string | null }): string {
  return revisionIdentity(revision.revision, revision.contractHash ?? textHash(revision.direction, revision.acceptance))
}
