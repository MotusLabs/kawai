// The `implementation-contract` validation check (implementation-contract
// design D5, table V1–V5): every registered change's design.md carries a
// parseable `## Implementation contract` section. Reported under `intent`;
// a change that is not registered is skipped, because `change-registered`
// already blocks it. One error per change carries every parser problem with
// its line; a change that parses records its contract hash as evidence. The
// file phase reads design.md from the change's resolved directory, which the
// input hash already digests.
import type { Finding } from '../../../shared/planValidation'
import { findingKey } from '../../../shared/planValidation'
import { parseContract } from '../../../shared/implementationContract'
import { contractHash } from '../../team/contractHash'
import type { ValidationCheck } from './validationChecks'

export const CONTRACT_CHECK = 'implementation-contract'

export const contractCheck: ValidationCheck = {
  name: CONTRACT_CHECK,
  row: 'intent',
  run: ({ content, resolved, designs }) => content.changes.flatMap((change): Finding[] => {
    if (resolved[change.change]?.status !== 'registered') return []
    const base = { check: CONTRACT_CHECK, key: findingKey(CONTRACT_CHECK, change.change), row: 'intent' as const, subject: change.change }
    const text = designs[change.change] ?? null
    if (text === null) {
      return [{ ...base, severity: 'error', message: `${change.change} has no design.md, so no Implementation contract section.` }]
    }
    const parsed = parseContract(text)
    if (parsed.contract) {
      const hash = contractHash(parsed.contract)
      return [{ ...base, severity: 'evidence', message: `${change.change}'s implementation contract parses (hash ${hash.slice(0, 12)}).`, detail: { hash } }]
    }
    return [{
      ...base, severity: 'error',
      message: `${change.change}'s design.md: ${parsed.problems.map(problem => `line ${problem.line}: ${problem.message}`).join('; ')}`,
      detail: { problems: parsed.problems },
    }]
  }),
}
