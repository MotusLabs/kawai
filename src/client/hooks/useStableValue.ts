// useStableValue.ts - value-stable memoization: keeps the previous reference
// while a new value compares equal, so identity-sensitive consumers (React.memo
// comparators, context providers) do not see churn from freshly built arrays.

import { useState } from 'react'

/**
 * Returns `value`, or the previous reference when the new value compares
 * equal by the injected predicate. Uses the setState-during-render pattern
 * React documents for deriving state from props; the extra render pass only
 * happens when the value actually changes.
 */
export function useStableValue<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const [state, setState] = useState(value)
  if (!isEqual(state, value)) {
    setState(value)
  }
  return state
}

/** Element-wise equality for arrays of strings (e.g. sortable item ids). */
export function stringArraysEqual(a: string[], b: string[]): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]))
}
