// Environment, permission and seam table, INPUTS ONLY (design "Environment,
// permission and seam table", task 1.3). Observable results are added after
// the blind cross-model reading resolves them.

export interface PolicyRow {
  id: string
  inputs: string
}

export const POLICY_ROWS: readonly PolicyRow[] = [
  { id: 'P01', inputs: 'Missing env or required home; runtime claude or codex' },
  { id: 'P02', inputs: 'Poisoned ambient credentials; explicit Anthropic OAuth env' },
  { id: 'P03', inputs: 'Proxy URL + custom header + placeholder token; hostile env/settings' },
  { id: 'P04', inputs: 'Explicit Codex home + poisoned Claude env' },
  { id: 'P05', inputs: 'Restricted Claude; tool in explicit read set' },
  { id: 'P06', inputs: 'Restricted Claude bypass; Bash/five named tools/unknown tool' },
  { id: 'P07', inputs: 'Codex never; sandbox workspace-write/read-only/none' },
  { id: 'P08', inputs: 'Two sessions; different permission/profile configuration' },
  { id: 'P09', inputs: 'Empty custom tools/context/wire' },
  { id: 'P10', inputs: 'Known tool; wrong thread/namespace/schema or unknown name' },
  { id: 'P11', inputs: 'Valid bound tool and schema' },
  { id: 'P12', inputs: 'Context callback refuses/throws' },
  { id: 'P13', inputs: 'Context callback accepts' },
  { id: 'P14', inputs: 'Names-only observer; secret-bearing tool input' },
  { id: 'P15', inputs: 'Observation hook throws; any permission decision' },
  { id: 'P16', inputs: 'Non-root, explicit cwd/home/cache/temp; optional sinks absent' },
]

/** Policy invariants checked by seeded cases at actual spawn/permission wiring. */
export const POLICY_INVARIANTS = [
  { id: 'I3', claim: 'Final process/probe env equals the explicit approved map; parent and sibling maps unchanged', seed: 0xa603, cases: 256 },
  { id: 'I4', claim: 'A denied/unlisted tool never executes or gains a permission from observation', seed: 0xa604, cases: 256 },
] as const

/** Ids must run P01..Pn without gaps or duplicates. */
export function policyIdErrors(rows: readonly PolicyRow[]): string[] {
  const errors: string[] = []
  rows.forEach((row, index) => {
    const expected = `P${String(index + 1).padStart(2, '0')}`
    if (row.id !== expected) errors.push(`row ${index}: ${row.id} where ${expected} belongs`)
  })
  return errors
}
