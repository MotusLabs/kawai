// packageCollection.test.ts - The root unit collector over the agent-runtime
// package (extract-agent-runtime 6.4): the runner's real collectFiles lists
// every package test file exactly once beside every root file, and planRun
// schedules exactly that multiset in the main batch, so the stock check runs
// and records each of them.
// @reads: packages/agent-runtime/**
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { planBatches, toTestFilePath } from '../planBatches'
import { planRun } from '../runPlan'
import { collectFiles, parseRunArgs } from '../test-runner'

const PACKAGE = 'packages/agent-runtime'

describe('the root collector over the agent-runtime package (6.4)', () => {
  test('collectFiles collects every agent-runtime package test file exactly once', async () => {
    const files = await collectFiles()
    const all = [...files.serverTests, ...files.clientTests, ...files.runnerTests, ...files.sharedTests, ...files.packageTests]
    expect(all.length).toBe(new Set(all).size)
    const onDisk = fs
      .readdirSync(`${PACKAGE}/__tests__`)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `${PACKAGE}/__tests__/${name}`)
      .sort()
    expect(onDisk.length).toBeGreaterThan(50)
    expect(files.packageTests.filter((file) => file.startsWith(`${PACKAGE}/`))).toEqual(onDisk)
    expect(all.filter((file) => file.startsWith(`${PACKAGE}/`))).toEqual(onDisk)
  })

  test('planRun schedules exactly the collected files, each package test once, in the main batch', async () => {
    const collected = await collectFiles()
    const all = [...collected.serverTests, ...collected.clientTests, ...collected.runnerTests, ...collected.sharedTests, ...collected.packageTests]
    const plan = planRun({
      args: parseRunArgs(['--skip-real-tmux']),
      workers: 4,
      collected,
      serialFiles: [],
      mainLabel: 'main batch',
      seedText: null,
      seedTimings: () => null,
    })
    expect([...plan.batchOptions.mainFiles].sort()).toEqual([...all].sort())
    const batches = planBatches(plan.batchOptions)
    expect(batches.map((batch) => batch.kind)).toEqual(['parallel'])
    const scheduled = batches[0]!.cmd.filter((arg) => arg.startsWith(`./${PACKAGE}/`))
    expect(scheduled).toEqual(collected.packageTests.map(toTestFilePath))
    expect(new Set(scheduled).size).toBe(scheduled.length)
    expect(scheduled.length).toBeGreaterThan(50)
  })
})
