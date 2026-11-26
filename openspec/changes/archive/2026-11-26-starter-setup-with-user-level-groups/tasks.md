# Tasks

## 1. New Session notice

- [x] 1.1 Make the notice follow the current setup answer and the actual picker choices. Preserve the notice link, path and terminal behavior, and chat creation. Commit N1–N5 as table-driven modal tests with independent setup and picker inputs. Verify the group route with real valid and malformed user files. Removing the picker eligibility condition must fail N2.

## 2. Setup preview

- [x] 2.1 Add the per-file warning through the existing workspace preview, with the catalog’s effective home and the existing project target. Keep existing warnings and the setup write behavior. Commit W1–W4 as table-driven tests, plus P1 and P2. Verify the real preview connection for W1 and W2. Dropping the override must fail W1 and filtering on parsed groups must fail W2.
- [x] 2.2 Cover the replacement warning and usable Confirm in the existing setup-control tests. Update the relevant Team page documentation for the modal notice and preview. Verify W1 with the replacement warning visible and Confirm enabled. A control that disables Confirm when warnings exist must fail.

## 3. Browser and result verification

- [x] 3.1 Move the existing team-setup walkthrough to the CI development fixture path with its own app process and isolated HOME, repo, database, tmux socket and port. Check the empty-home notice and Members link, the offered user group and hidden notice, the replacement warning before confirmation, and the untracked template files and preserved user file after confirmation. Verify N1, N2, W1 and I1 on the exact build. A missing picker gate or preview warning must be observable as a failing assertion.
- [x] 3.2 Run affected tests, strict OpenSpec validation and the literal citation preflight, then run the pinned Bun full-properties check on the clean committed candidate and the current result verifier. Provide the N1–N5, W1–W4, P1 and P2 test citations and the named negative-control outcomes from the prior tasks. Record the browser run and any limitations with the complete result.
