# Unroll evidence (closeout task 7.1, contract A2)

`before/` and `after/` hold the JUnit reports of the four files that had
template-generated rows, captured immediately before the unroll (at the task
baseline `29243fc4`) and after it (commit `c1c14b6d`). A mechanical
comparison of the `<testcase name="…">` lists — order included — shows all
four identical:

- `realTmuxSelection`: 24 tests before, 24 after, identical
- `runPlanRetry`: 14 before, 14 after, identical
- `checkRunReuse`: 19 before, 19 after, identical
- `pushReducedPass`: 4 before, 4 after, identical

Each new title is byte-equal to the text its template rendered, and no
file's test count dropped. The row tables and row bodies are unchanged in
the commit; only the loops became literal calls.
