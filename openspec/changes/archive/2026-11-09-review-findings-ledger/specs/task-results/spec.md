## MODIFIED Requirements

### Requirement: Findings are bound to the result examined
Any team member SHALL submit review or QA findings with `task_submit_findings`, naming the exact result examined, as structured findings with a derived verdict or as text with a verdict. Findings SHALL apply only to the result they name: a newer result or commit SHALL NOT inherit them. When a newer result supersedes an earlier one, the earlier result and its findings SHALL remain readable with their binding unchanged.

#### Scenario: Findings name the examined result
- **WHEN** a reviewer submits findings for a result
- **THEN** they attach to that result with the reviewer, the verdict, and the time, visible beside it

#### Scenario: A newer commit inherits no approval
- **WHEN** the developer submits a new result after findings were reported on the earlier one
- **THEN** the earlier findings do not approve or transfer to the new result

#### Scenario: Structured findings carry a derived verdict
- **WHEN** a reviewer submits structured findings without a verdict
- **THEN** they attach to the result with the verdict the ledger derives, and each finding with its id and class

#### Scenario: Text findings outside plan execution
- **WHEN** a reviewer submits text with a `fail` verdict on a task that is not a plan change's task
- **THEN** they attach to the result as unstructured findings with that verdict
