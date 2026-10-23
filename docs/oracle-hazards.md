# Oracle hazard catalog

Hazards that acceptance oracles have caught or should have caught, organized
by change class. Consult it while writing a design's "Acceptance oracles"
subsection (docs/agent-collaboration.md, "Write acceptance as oracles"), and
add an entry for every new blocking finding: the reviewer reports a defect
outside the tables as a proposed oracle amendment, the Lead decides, and the
decision lands here. Each entry names the class, the hazard, the oracle row
or property that would have caught it, and the source finding.

## State machines with recovery

### B1 — the superseded actor's later writes (findings-60ea7371, RC E)

- **Hazard.** After a Restart, reassignment or forward, the old holder keeps
  writing — results, findings, checkpoints — and the tables have no row for
  an actor that was already superseded.
- **Oracle that catches it.** Table rows for the old holder's submissions in
  both windows, before and after the new dispatch. They are judged from
  stored rows, so the answer is the same either way; the property oracle is
  "claimed work never cancelled; the old holder refused from rows"
  (revision-control design.md, P-I2).
- **Source finding.** findings-60ea7371 (RC E).

## Test seams

### M1 — an oracle behind a hand-built harness (findings-6a6a844d)

- **Hazard.** The oracle passes inside a test-only composition while the
  production wiring never reaches the guarded seam, so the covered behavior
  is not what ships.
- **Oracle that catches it.** At least one oracle test per guarded seam runs
  through the production composition, and its mutant removes the wiring
  (revision-control design.md, the OG1 row).
- **Source finding.** findings-6a6a844d.

## Command surfaces

### Refusals missing the success envelope

- **Hazard.** A refusal path omits the envelope or headers every success
  carries, and a caller reads the difference as success, or crashes on the
  missing field.
- **Oracle that catches it.** A decision-table row for every refusal,
  asserting the same envelope and headers the success rows assert.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

## Path and identity checks

### A root swap escaping a listed-root check

- **Hazard.** Comparing a caller-supplied path against listed roots by
  prefix or unnormalized string lets a root swap — a symlink, a `..`
  segment, an alias — pass a membership check it should fail.
- **Oracle that catches it.** Compare lexically against the listed roots,
  after normalization, with a decision-table row per alias class.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

## Derived state

### Several readers disagreeing on derived state

- **Hazard.** Each stage re-derives the same state with its own logic, the
  readers drift apart, and one stage acts on a different answer to one
  question than the stage before it.
- **Oracle that catches it.** One function derives the state, and each stage
  gets its own table row over that shared derivation.
- **Source finding.** RC E seed (no finding record — cataloged at rule
  adoption).

