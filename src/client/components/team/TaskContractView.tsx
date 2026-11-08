// A revision's implementation contract (implementation-contract D7): its
// identity (`r<revision>#<hash>`), then each part's clauses with their ids
// and the scope globs — or, for a revision without one, its text identity
// labeled "No contract". Used for the current revision and in the history.
import type { ImplementationContract } from '@shared/implementationContract'
import { CONTRACT_PARTS } from '@shared/implementationContract'

export default function TaskContractView({ identity, contract, testId = 'task-contract' }: {
  identity: string | undefined
  contract: ImplementationContract | null | undefined
  testId?: string
}) {
  if (!contract) {
    return <p className="text-chat-meta text-secondary" data-testid={testId} data-contract="none">
      No contract{identity ? <> · <code data-testid="contract-identity">{identity}</code></> : null}</p>
  }
  return <div className="text-chat-meta" data-testid={testId} data-contract="present">
    <p>Contract <code data-testid="contract-identity">{identity}</code></p>
    {CONTRACT_PARTS.map(part => {
      const entries = part.key === 'scope'
        ? contract.scope.map(glob => <li key={glob}><code>{glob}</code></li>)
        : contract[part.key].map(clause => <li key={clause.id}><span className="font-medium">{clause.id}</span>: {clause.text}</li>)
      return <div key={part.key} className="mt-1" data-part={part.key}>
        <p className="text-secondary">{part.heading}</p>
        {entries.length > 0 ? <ul className="ml-4 list-disc">{entries}</ul> : <p className="ml-4 text-secondary">None</p>}
      </div>
    })}
  </div>
}
