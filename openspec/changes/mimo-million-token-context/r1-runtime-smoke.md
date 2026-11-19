# R1 runtime smoke — UNVERIFIED

Status: **UNVERIFIED** (recorded 2026-11-18 by the implementing agent; task
4.1 is an owner gate and was not run).

R1 requires a credentialed smoke with the owner's MiMo credentials and
consent, on the minimum supported Claude Code CLI (`CLAUDE_CODE_MIN_VERSION`,
2.1.289), against the normalized MiMo launch. It was not performed:

- No owner MiMo credentials or consent were available to the agent, and the
  task forbids an agent credentialed run (contract X4).
- The CLI on the workspace PATH is 2.1.326 (`claude --version`), not the
  2.1.289 baseline; a newer CLI does not certify R1, and no baseline bump is
  authorized.
- No raw context report from a MiMo session was inspected.

Therefore none of R1's fields are known: recognized capacity, effective
`isAutoCompactEnabled` and window, the raw report / threshold / reserve
fields, and the accepted untagged Pro and Flash model ids remain
**unverified**. The 167K-meter diagnosis in proposal.md stays a hypothesis.
No report fixture was saved, and no live chat was touched.

What is verified instead is the launch Kawai composes, by automated tests
over the shipped catalog on an isolated empty home (row C1) and through the
real manager (rows L1-L7, M1 with a synthetic report). Whether the installed
CLI honors that launch as intended is exactly what R1 would establish.

To complete R1 the owner runs a disposable session on CLI 2.1.289 with MiMo
credentials and a minimal prompt, and records the CLI version, the fields
above per their versioned meanings, and a redacted report fixture.
