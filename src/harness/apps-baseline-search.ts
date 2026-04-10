import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkTask, BenchmarkVariant } from "./benchmark-types.js";
import { CommandAgentAdapter } from "./command-agent-adapter.js";
import { readJsonlFile, writeJsonFile, writeJsonlFile } from "./jsonl.js";

async function main(): Promise<void> {
  process.loadEnvFile?.();
  const tasksPath = requiredFlag("--tasks");
  const outDir = flagValue("--out") ?? "artifacts/apps-baseline-search";
  const selectCount = Number(flagValue("--select") ?? "3");
  const modelName = flagValue("--model") ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";

  const tasks = await readJsonlFile<BenchmarkTask>(tasksPath);
  await mkdir(outDir, { recursive: true });

  const adapter = new CommandAgentAdapter("npx", ["tsx", "src/apps-agent.ts"], "apps-command-agent");
  const variant: BenchmarkVariant = {
    id: "baseline",
    modelName,
    systemPrompt: "Solve the task without context compression."
  };

  const runs = [];
  const selected: BenchmarkTask[] = [];

  for (const task of tasks) {
    const runId = `baseline_${task.instanceId}`;
    const result = await adapter.runTask(task, variant, {
      runId,
      artifactDir: path.join(outDir, "runs", runId)
    });
    const record = {
      instanceId: task.instanceId,
      resolved: result.resolved ?? false,
      usage: result.usage,
      summary: result.summary,
      metadata: result.metadata,
      artifacts: result.artifacts
    };
    runs.push(record);
    if ((result.resolved ?? false) && selected.length < selectCount) {
      selected.push(task);
    }
  }

  await writeJsonlFile(path.join(outDir, "baseline-search-runs.jsonl"), runs);
  await writeJsonlFile(path.join(outDir, "selected.tasks.jsonl"), selected);
  await writeJsonFile(path.join(outDir, "selected.summary.json"), {
    sourceTasks: tasks.length,
    selectedCount: selected.length,
    selectedIds: selected.map((task) => task.instanceId)
  });
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredFlag(name: string): string {
  const value = flagValue(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }
  return value;
}

void main();
