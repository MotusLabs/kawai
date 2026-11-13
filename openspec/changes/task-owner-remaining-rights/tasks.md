## 1. Disputes follow the owner

- [x] 1.1 `FindingDisputes.decide` allows the human or `taskOwner(task)`, and its refusal names the owner via `ownerLabel`
- [x] 1.2 The manual dispute mail goes to `taskOwner(task)`, with none when the owner is null
- [x] 1.3 `task_decide_dispute`'s description says "a task you own"
- [x] 1.4 Tests in `findingDisputes.test.ts`: the owner rejects; a non-owner is refused; after a handover the mail reaches the new owner, the new owner decides, and the creator is refused. Each scenario of the modified requirement carries `@covers`

## 2. The exhaustion note falls back to the owner

- [x] 2.1 `ExhaustionNotes.recipientFor` falls back to `taskOwner(task)`
- [x] 2.2 Test in `contextExhaustion.integration.test.ts`: an unassigned task handed to another lead sends the note to that lead and not to the creator. Annotate the existing lead-dispatch test for "Lead dispatched the work", and add assignment-based tests for "Human dispatched the work" and "Dispatcher itself exhausted"

## 3. Team files

- [x] 3.1 After the human reviews it, replace the `change-leads.md` recovery paragraph with the D3 text, and assert it in `teamGroupFile.test.ts` under the change-coordination takeover scenarios
- [x] 3.2 Set `lead.md` to `max: 2`

## 4. Verify

- [x] 4.1 Run mutants: revert each creator-to-owner switch in turn (decide, mail, exhaustion fallback), and check that a test fails for each
- [ ] 4.2 `openspec validate task-owner-remaining-rights --strict` and `bun run check` pass
