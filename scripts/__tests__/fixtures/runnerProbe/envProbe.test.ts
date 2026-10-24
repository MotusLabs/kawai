// envProbe.test.ts — runnerRoots' probe for the batch environment (D7):
// the runner consumes KAWAI_TEST_JUNIT_DIR at plan time and must not pass
// it down, so a runner a test spawns never plans reports into the check's
// directory through an inherited value.
import { test, expect } from 'bun:test'

test('the batch environment carries no report directory', () => {
  expect(process.env.KAWAI_TEST_JUNIT_DIR).toBeUndefined()
})
