// A revision row's contract (implementation-contract design D2, D3), kept
// beside `taskStore.ts` so that file stays within the 500-line rule: the
// columns a contract writes, the fields a row reads back, and the
// carry-forward rule (C1–C7) a publication applies inside its transaction,
// and the parse of a caller's contract text. Pure apart from the sha256.
import { parseContract, type ImplementationContract } from '../../shared/implementationContract'
import { contractHash, identityOf } from './contractHash'

export interface ContractColumns {
  contract: string | null
  contract_hash: string | null
}

/** The fields of a task or revision that carry its contract. */
export interface ContractFields {
  contract: ImplementationContract | null
  contractHash: string | null
  identity: string
}

export function contractColumns(contract: ImplementationContract | null): ContractColumns {
  return contract === null
    ? { contract: null, contract_hash: null }
    : { contract: JSON.stringify(contract), contract_hash: contractHash(contract) }
}

/** Read a row's contract columns, and the revision's identity (its contract's, else its text's). */
export function contractFields(row: Record<string, unknown>, revision: number, direction: string, acceptance: string | null): ContractFields {
  const hash = typeof row.contract_hash === 'string' ? row.contract_hash : null
  const contract = hash !== null && typeof row.contract === 'string' ? JSON.parse(row.contract) as ImplementationContract : null
  return { contract, contractHash: contract === null ? null : hash, identity: identityOf({ revision, direction, acceptance, contractHash: contract === null ? null : hash }) }
}

/**
 * The contract the next revision carries (C1–C7): omitted carries the
 * current one; a contract replaces it; an explicit clear is refused once a
 * revision carried one (C6) and leaves none otherwise (C7).
 */
export function nextContract(current: ImplementationContract | null, input: ImplementationContract | null | undefined): ImplementationContract | null {
  if (input === undefined) return current
  if (input === null && current !== null) {
    throw new Error('The contract cannot be removed once a revision carried one; publish a replacement contract instead. Nothing was published.')
  }
  return input
}

/**
 * Resolve a caller's contract text before anything is written (C5). Omitted
 * or blank text is "omitted" for agents (the tools cannot express a clear);
 * the human's blank text is an explicit clear (C6, C7). Text that does not
 * parse refuses with every problem the parser reported.
 */
export function contractInput(text: string | null | undefined, blankClears: boolean): ImplementationContract | null | undefined {
  if (text === undefined || text === null) return undefined
  if (!text.trim()) return blankClears ? null : undefined
  const parsed = parseContract(text)
  if (parsed.contract) return parsed.contract
  throw new Error(`The contract does not parse; nothing was written:\n${parsed.problems.map(problem => `- line ${problem.line}: ${problem.message}`).join('\n')}`)
}
