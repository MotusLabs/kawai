// Plan content fixtures for the durable-plans tests: a complete, valid
// two-change plan (`api` then `ui`) whose parts tests override.
export function planInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: 'Durable plans the owner approves',
    successCriteria: ['A plan survives a restart'],
    nonGoals: ['Execution'],
    approach: 'Mirror the strategy module',
    alignment: { statement: 'Serves durable records', refs: [] },
    changes: [
      { change: 'api', dependsOn: [], group: 'middle-devs', acceptance: ['API lands'], extraChecks: [], guidance: '' },
      { change: 'ui', dependsOn: ['api'], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: 'Use the store' },
    ],
    acceptanceRules: [],
    extraChecks: [],
    landing: { mode: 'direct' },
    roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }],
    reviewGroup: 'reviewers',
    ...overrides,
  }
}
