import { test } from 'bun:test'
import { recordRoots } from './recordRoots'

recordRoots('sleepProbe')

// Long enough that the outer test can SIGTERM the runner mid-run; the
// timeout is large so the file fails only if the kill never comes.
test('sleepProbe waits to be killed', async () => {
  await Bun.sleep(120_000)
}, 150_000)
