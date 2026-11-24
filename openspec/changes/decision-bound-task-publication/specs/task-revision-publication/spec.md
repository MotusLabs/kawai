# Spec Delta

## ADDED Requirements

### Requirement: An approved handoff publishes as the human with its original notices
A decision-bound publication SHALL use the existing prepared handoff publisher as the human. The revision SHALL be associated with the exact handoff and written in the same transaction as the decision, receipt, handoff disposition and applicable notice intents. The write SHALL preserve drafts and notify the existing holder through the normal revision notice path.

#### Scenario: Publication reaches the current holder and requester
- **WHEN** a reviewed handoff is approved, including after holder replacement or forwarding before commit
- **THEN** the associated revision records the prepared rationale and human author, the existing current holder gets one normal direct revision notice naming the published revision, the requester gets the existing publication wakeup when routable, and the draft is unchanged

#### Scenario: An unclaimed assignment needs no notice
- **WHEN** the owner publishes from a decision while the outstanding group assignment is unclaimed
- **THEN** the receipt has no holder notice, no group revision notice is sent, and the ordinary instruction carries the current revision when delivered

#### Scenario: Delivery and acknowledgement remain distinct
- **WHEN** a notice is delivered, fails, is uncertain, or is retried under the existing mailbox rules
- **THEN** the receipt, publication and earlier message and result pins are unchanged, and only a separate explicit acknowledgement for a published revision advances the holder's acknowledgement

### Requirement: A decision-bound publication preserves execution gates
A decision-bound publication SHALL defer to normal task revision re-evaluation and Kawai's stage ownership. An affected undecided pause, including a draining target, SHALL refuse a fresh combined action. New affected pause history SHALL stale the binding. The action SHALL leave unrelated pauses and ordinary holds in force, and SHALL never approve a plan, release a hold, resolve a pause, stop or retry an execution, or accept a result.

#### Scenario: A pause or Adapt wins independently
- **WHEN** a pause targets the reviewed task's change after binding, whether the target is still draining, fully paused or later resolved on the same base
- **THEN** fresh approval is refused, and a subsequent or already committed Adapt follows its existing publication behavior with no decision receipt for the bound card

#### Scenario: Unrelated pauses and holds preserve normal behavior
- **WHEN** the reviewed change is eligible and an unrelated pause or an ordinary hold exists
- **THEN** the exact approval can publish with the usual revision fact, while holds still prevent dispatch where they normally apply and all existing human-only gates and execution ownership remain in force
