import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { BenchmarkRunner, estimateCost, summarizeRuns } from "../src/harness/benchmark.js";
import type { BenchmarkRunRecord, BenchmarkTask } from "../src/harness/benchmark-types.js";
import { readJsonlFile } from "../src/harness/jsonl.js";
import { MockAgentAdapter } from "../src/harness/mock-agent-adapter.js";

test("estimateCost uses separate input and output token totals", () => {
  const cost = estimateCost(
    {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      totalTokens: 2_500_000
    },
    {
      inputCostPer1M: 0.5,
      outputCostPer1M: 1.5
    }
  );

  assert.equal(cost.inputCost, 1);
  assert.equal(cost.outputCost, 0.75);
  assert.equal(cost.totalCost, 1.75);
});

test("paired benchmark run writes records and predictions with scenario buckets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "compressor-bench-test-"));
  const runner = new BenchmarkRunner(new MockAgentAdapter(), {
    inputCostPer1M: 0.8,
    outputCostPer1M: 3.2
  });

  const tasks: BenchmarkTask[] = [
    { instanceId: "t1", repo: "repo", problemStatement: "one" },
    { instanceId: "t2", repo: "repo", problemStatement: "two" },
    { instanceId: "t3", repo: "repo", problemStatement: "three" },
    { instanceId: "t4", repo: "repo", problemStatement: "four" }
  ];

  try {
    const runs = await runner.runPaired(tasks, tempDir, [
      { id: "baseline", modelName: "demo", systemPrompt: "baseline" },
      { id: "compressed", modelName: "demo", systemPrompt: "compressed" }
    ]);

    assert.equal(runs.length, 8);
    assert.ok(runs.every((run) => run.scenarioBucket !== undefined));

    const persistedRuns = await readJsonlFile<BenchmarkRunRecord>(path.join(tempDir, "runs.jsonl"));
    assert.equal(persistedRuns.length, 8);

    const summary = summarizeRuns(
      persistedRuns.map((run, index) => ({
        ...run,
        resolved: index % 2 === 0
      })),
      {
        inputCostPer1M: 0.8,
        outputCostPer1M: 3.2
      }
    );

    assert.ok(summary.overall.tokenReductionRate > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
