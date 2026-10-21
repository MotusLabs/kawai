import { test } from 'bun:test'
import { recordRoots } from './recordRoots'

// F5 fixture (main-batch file): ignores SIGTERM — so the runner's forwarded
// signal does not kill it — and still exits 0. That is the race where the
// batch loop could spawn the next batch after a handled signal. recordRoots
// runs at module load, after this file's SIGTERM handler is installed.
process.on('SIGTERM', () => {})
recordRoots('signalRaceProbe')

test('signalRaceProbe ignores SIGTERM and passes', async () => {
  await Bun.sleep(1_500)
}, 10_000)
