// Contract hashes and identities (implementation-contract design D2).
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { contractHash, identityOf, textHash } from '../team/contractHash'
import { contractHashInput, parseContract } from '../../shared/implementationContract'

const TEXT = ['## Implementation contract', '### Acceptance', '- A1: Lists tasks', '### Invariants', '- I1: Never twice',
  '### Scope', '- src/server/**', '### Verification', '- V1: check passes', '### Excluded'].join('\n')
const parse = (text: string) => {
  const parsed = parseContract(text)
  if (!parsed.contract) throw new Error(JSON.stringify(parsed.problems))
  return parsed.contract
}

test('the contract hash is the sha256 of the canonical input', () => {
  const contract = parse(TEXT)
  expect(contractHash(contract)).toBe(createHash('sha256').update(contractHashInput(contract)).digest('hex'))
})

// @covers: implementation-contract › A contract has a canonical hash and an identity › Formatting does not change the hash
test('CRLF, trailing spaces, and blank lines leave the hash unchanged', () => {
  const variant = TEXT.split('\n').map(line => `${line}  `).join('\r\n\r\n')
  expect(contractHash(parse(variant))).toBe(contractHash(parse(TEXT)))
})

// @covers: implementation-contract › A contract has a canonical hash and an identity › Wording changes the hash
test('editing the text of I1 changes the hash', () => {
  expect(contractHash(parse(TEXT.replace('Never twice', 'Never thrice')))).not.toBe(contractHash(parse(TEXT)))
})

// @covers: implementation-contract › A revision without a contract has a text identity › Legacy task
test('a revision without a contract is identified by its direction and acceptance', () => {
  const legacy = { revision: 2, direction: 'Build it', acceptance: null, contractHash: null }
  const identity = identityOf(legacy)
  expect(identity).toBe(`r2#${textHash('Build it', null).slice(0, 12)}`)
  expect(identityOf({ ...legacy, acceptance: 'Tests pass' })).not.toBe(identity)
  expect(identityOf({ ...legacy, direction: 'Build that' })).not.toBe(identity)
})

test('a revision with a contract is identified by its contract hash', () => {
  const hash = contractHash(parse(TEXT))
  expect(identityOf({ revision: 3, direction: 'x', acceptance: null, contractHash: hash })).toBe(`r3#${hash.slice(0, 12)}`)
})
