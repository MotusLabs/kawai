## 1. Disputes follow the owner

- [ ] 1.1 `FindingDisputes.decide` allows the human or `taskOwner(task)`, and its refusal names the owner via `ownerLabel`
- [ ] 1.2 The manual dispute mail goes to `taskOwner(task)`, with none when the owner is null
- [ ] 1.3 `task_decide_dispute`'s description says "a task you own"
- [ ] 1.4 Tests in `findingDisputes.test.ts`: the owner rejects; a non-owner is refused; after a handover the mail reaches the new owner, the new owner decides, and the creator is refused. Each scenario of the modified requirement carries `@covers`

## 2. The exhaustion note falls back to the owner

- [ ] 2.1 `ExhaustionNotes.recipientFor` falls back to `taskOwner(task)`
- [ ] 2.2 Test in `contextExhaustion.integration.test.ts`: an unassigned task handed to another lead sends the note to that lead and not to the creator. Annotate the existing tests for "Lead dispatched the work", "Human dispatched the work", and "Dispatcher itself exhausted"

## 3. Team files

- [ ] 3.1 After the human reviews it, replace the `change-leads.md` recovery paragraph with the D3 text, and assert it in `teamGroupFile.test.ts` under the change-coordination takeover scenarios
- [ ] 3.2 Set `lead.md` to `max: 2`

## 4. Verify

- [ ] 4.1 Run mutants: revert each creator-to-owner switch in turn (decide, mail, exhaustion fallback), and check that a test fails for each
- [ ] 4.2 `openspec validate task-owner-remaining-rights --strict` and `bun run check` pass
