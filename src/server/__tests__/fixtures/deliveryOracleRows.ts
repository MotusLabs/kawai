// Binding design tables copied verbatim at authoring time, not read at runtime.
// C6 belongs to the held reader phase; the C table here is C1-C5 only.

export const TABLE_L = [
  [
    "L1",
    "C is the first-parent commit F₂",
    "*",
    "position 2, `at` = ct(F₂)"
  ],
  [
    "L2",
    "C reached only through F₂'s second parent",
    "*",
    "position 2"
  ],
  [
    "L3",
    "C reachable from F₁ (t 100) and from F₂ (t 90)",
    "*",
    "position 1, `at` 100, never 90"
  ],
  [
    "L4",
    "a result names full literal D not in H's graph, with the strict same-result passing check of D1 (as L8b)",
    "*",
    "known, not landed"
  ],
  [
    "L4b",
    "the same D with only a pending check, or none",
    "*",
    "unresolvable: excluded from `landed_result_share`, never known-not-landed"
  ],
  [
    "L5a",
    "F₁ t 100, F₂ t 50 brings X through its second parent, F₃ t 200; X has U = [50, 100]",
    "40",
    "X not contained by T"
  ],
  [
    "L5b",
    "same",
    "75",
    "X's containment unknown at T: excluded from the share, counted in its coverage note"
  ],
  [
    "L5c",
    "same",
    "150",
    "X contained by T; its membership in [100, 150) is unknown (at 50 < 100), in [40, 150) it is in"
  ],
  [
    "L6",
    "F₁ t 1000, F₂ t 10 (old-dated), F₃ t 1100 brings X (ct 1050) through its second parent",
    "1200",
    "X landed at position 3, U = [1100, 1100] (no `--since` cut)"
  ],
  [
    "L7",
    "`commit_ref` is a 7- or 12-digit abbreviation of a graph commit, including one a later check resolved to a full id; symbolic text (`HEAD`, a branch name); a 39- or 41-digit hex; a 64-digit literal in a sha1 repository",
    "*",
    "unresolvable: excluded from `landed_result_share`, counted in its coverage note, never landed or known-not-landed"
  ],
  [
    "L8a",
    "a full literal C in H's graph",
    "*",
    "known; C's landing by position"
  ],
  [
    "L8b",
    "a full literal D off H's graph with one same team/task/result check: `done`, version 1, `commit.status` `pass`, `commit.given` = D, `commit.sha` = D",
    "*",
    "known, not landed; evidence names the check's id, `seq`, `finished_at`"
  ],
  [
    "L8c",
    "D off-graph with no check, or a check that is pending, unavailable, failed, of another result, missing `commit.sha`, or with `given` ≠ the literal",
    "*",
    "unresolvable"
  ],
  [
    "L8d",
    "D off-graph with two checks naming different `sha`",
    "*",
    "unresolvable"
  ],
  [
    "L8e",
    "C landed and an unmerged D share their first 7 digits; the result names the 7-digit prefix",
    "*",
    "unresolvable (no prefix search, whichever commit is unique in H's graph)"
  ],
  [
    "L8f",
    "`extensions.objectformat = sha256` in the config text; a 64-digit literal in the graph",
    "*",
    "known and landed; a 40-digit literal is unresolvable"
  ]
] as const

export const TABLE_I = [
  [
    "I1",
    "monotonic",
    "at = bound = T − d",
    "in",
    "out",
    "yes"
  ],
  [
    "I2",
    "monotonic",
    "at = bound = T",
    "out",
    "out",
    "yes; in the window ending T + d"
  ],
  [
    "I3",
    "monotonic",
    "at = bound = T − 2d",
    "out",
    "in",
    "yes"
  ],
  [
    "I4",
    "monotonic",
    "at = bound = T − 2d − 1 ms",
    "out",
    "out",
    "yes"
  ],
  [
    "I5",
    "F₁ at T − d + 1 h, then F₂ at T − 3d",
    "F₂: U = [T − 3d, T − d + 1 h]",
    "unknown",
    "unknown",
    "yes"
  ],
  [
    "I6",
    "F₁ at T + 1 h, then F₂ at T − 1 h",
    "F₂: U = [T − 1 h, T + 1 h]",
    "unknown",
    "out",
    "unknown"
  ],
  [
    "I7",
    "any",
    "at > T",
    "out",
    "out",
    "no"
  ]
] as const

export const TABLE_C = [
  [
    "C1",
    "added by a merge commit",
    "at the merge's position"
  ],
  [
    "C2",
    "added by a direct first-parent commit",
    "at that commit's position"
  ],
  [
    "C3",
    "added twice (re-archived under a new date)",
    "at the first arrival"
  ],
  [
    "C4",
    "added on an unmerged branch only",
    "not landed"
  ],
  [
    "C5",
    "added, later deleted from master",
    "landed at the arrival (history is not rewritten)"
  ]
] as const
