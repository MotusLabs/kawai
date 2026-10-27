# Tasks

## 1. Recommendation detection

- [x] 1.1 Extend `recommendedAnswers` with D1 label/description grammar, supported typo, normalization, negative precedence, and verbatim ordered labels; update the detection summary in `AGENTS.md`. Verify independently classified table-driven fixtures in `recommendedAnswers.test.ts` (QA-R1–QA-R5; kills dropping phrase/description/typo support, accepting negative/incidental signals, and changing or duplicating labels).
- [x] 1.2 Extend the existing seeded deadline property with independently classified label/description fixtures, empty-option inputs, single/multi-select questions, and zero/positive waits. Verify 300 cases at seed 20261024 (QA-P3; kills arming a deadline without every question being eligible).

## 2. Production composition

- [x] 2.1 Exercise description-only `I recomend this` through a manager-created driver with only the process timer replaced: original labels in the deadline and timeout result, agent note and timeout event, and a held second question never auto-answered. Verify the manager test and existing deadline/hold regressions (QA-R6; kills production suffix-only gating, submitting a description as an answer, and ignoring a hold).

## Workflow follow-up

- Review and archive this follow-up independently of the already archived original change.
