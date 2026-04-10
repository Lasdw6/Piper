import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { BenchmarkRunRecord, BenchmarkTask, BenchmarkVariant, CostBreakdown } from "./benchmark-types.js";
import { readJsonlFile, writeJsonFile, writeJsonlFile } from "./jsonl.js";
import { MiniSweAgentAdapter } from "./mini-swe-agent-adapter.js";

interface EvalRecord {
  instance_id: string;
  model_name_or_path: string;
  resolved: boolean;
  details?: string;
}

interface UsageTriple {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

async function main(): Promise<void> {
  process.loadEnvFile?.();

  const tasksPath = flagValue("--tasks") ?? "data/swebench-lite-local6.tasks.jsonl";
  const outputDir = flagValue("--out") ?? "artifacts/mini-swebench-local6-ablation";
  const python = flagValue("--python") ?? "python";
  const modelName = flagValue("--model") ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";
  const summarizerModel = flagValue("--summarizer-model") ?? process.env.BENCHMARK_SUMMARIZER_MODEL ?? "gpt-4.1-mini";
  const maxContextTokens = Number(flagValue("--max-context-tokens") ?? process.env.BENCHMARK_MAX_CONTEXT_TOKENS ?? "20000");
  const timeoutMs = Number(flagValue("--timeout-ms") ?? process.env.BENCHMARK_RUN_TIMEOUT_MS ?? "1800000");

  const tasks = await readJsonlFile<BenchmarkTask>(tasksPath);
  const adapter = new MiniSweAgentAdapter({ pythonExecutable: python, timeoutMs });
  const variants = buildVariants(modelName, summarizerModel, maxContextTokens);
  const partialRunsPath = path.join(outputDir, "runs.partial.jsonl");
  const progressPath = path.join(outputDir, "progress.json");

  await mkdir(outputDir, { recursive: true });

  const runs: BenchmarkRunRecord[] = (await pathExists(partialRunsPath)) ? await readJsonlFile<BenchmarkRunRecord>(partialRunsPath) : [];
  const completedRunIds = new Set(runs.map((run) => run.runId));
  const totalRuns = tasks.length * variants.length;
  await writeProgress(progressPath, {
    status: "running",
    completedRuns: runs.length,
    totalRuns,
    currentRunId: null,
    lastFinishedRunId: runs.at(-1)?.runId ?? null,
    startedAt: new Date().toISOString()
  });
  for (const task of tasks) {
    for (const variant of variants) {
      const runId = `${variant.id}_${task.instanceId}`;
      if (completedRunIds.has(runId)) {
        continue;
      }
      const runArtifactDir = path.join(outputDir, "runs", runId);

      console.log(`[${runs.length + 1}/${totalRuns}] starting ${runId}`);
      await writeProgress(progressPath, {
        status: "running",
        completedRuns: runs.length,
        totalRuns,
        currentRunId: runId,
        lastFinishedRunId: runs.at(-1)?.runId ?? null,
        startedAt: new Date().toISOString()
      });

      let result;
      try {
        result = await adapter.runTask(task, variant, {
          runId,
          artifactDir: runArtifactDir
        });
      } catch (error) {
        result = {
          patch: "",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turnUsages: [],
          summary: error instanceof Error ? error.message : "run failed",
          metadata: {
            run_error: error instanceof Error ? error.message : "run failed"
          },
          artifacts: {
            runDir: runArtifactDir,
            payloadPath: path.join(runArtifactDir, "payload.json"),
            rawResultPath: path.join(runArtifactDir, "result.raw.json"),
            stdoutPath: path.join(runArtifactDir, "stdout.log"),
            stderrPath: path.join(runArtifactDir, "stderr.log"),
            trajectoryPath: path.join(runArtifactDir, "trajectory.json"),
            serializedPath: path.join(runArtifactDir, "serialized.json"),
            compressionDebugPath: path.join(runArtifactDir, "compression-debug.json"),
            errorPath: path.join(runArtifactDir, "error.json")
          }
        };
      }

      const run: BenchmarkRunRecord = {
        runId,
        adapter: adapter.name,
        variantId: variant.id,
        instanceId: task.instanceId,
        repo: task.repo,
        modelName: variant.modelName,
        evaluationModelName: `${variant.modelName}__${variant.id}`,
        patch: result.patch,
        usage: result.usage,
        turnUsages: result.turnUsages ?? [],
        peakInputTokens: Math.max(0, ...(result.turnUsages ?? []).map((entry) => entry.inputTokens))
      };

      if (result.summary !== undefined) {
        run.summary = result.summary;
      }
      if (result.metadata !== undefined) {
        run.metadata = result.metadata;
      }
      if (result.artifacts !== undefined) {
        run.artifacts = result.artifacts;
      }

      runs.push(run);
      completedRunIds.add(runId);
      await writeJsonlFile(partialRunsPath, runs);
      await writeProgress(progressPath, {
        status: "running",
        completedRuns: runs.length,
        totalRuns,
        currentRunId: null,
        lastFinishedRunId: runId,
        startedAt: new Date().toISOString()
      });
      console.log(
        `[${runs.length}/${totalRuns}] finished ${runId} ` +
          `tokens=${run.usage.totalTokens} peak=${run.peakInputTokens} summary=${run.summary ?? ""}`
      );
    }
  }

  const bucketedRuns = assignScenarioBuckets(runs);
  await writeJsonlFile(path.join(outputDir, "runs.jsonl"), bucketedRuns);

  for (const variant of variants) {
    await writeJsonlFile(
      path.join(outputDir, `${variant.id}.predictions.jsonl`),
      bucketedRuns
        .filter((run) => run.variantId === variant.id)
        .map((run) => ({
          instance_id: run.instanceId,
          model_name_or_path: run.evaluationModelName,
          model_patch: run.patch
        }))
    );
  }

  for (const variant of variants) {
    await runProcess(
      python,
      [
        "src/local_verify.py",
        "--tasks",
        tasksPath,
        "--predictions",
        path.join(outputDir, `${variant.id}.predictions.jsonl`),
        "--output",
        path.join(outputDir, `${variant.id}.eval.jsonl`)
      ],
      process.cwd()
    );
  }

  const evalRows = (
    await Promise.all(
      variants.map((variant) => readJsonlFile<EvalRecord>(path.join(outputDir, `${variant.id}.eval.jsonl`)))
    )
  ).flat();

  const resolvedByKey = new Map(evalRows.map((row) => [`${row.model_name_or_path}::${row.instance_id}`, row.resolved]));
  const mergedRuns = bucketedRuns.map((run) => ({
    ...run,
    resolved: resolvedByKey.get(`${run.evaluationModelName}::${run.instanceId}`) ?? false
  }));

  await writeJsonlFile(path.join(outputDir, "runs.with-eval.jsonl"), mergedRuns);
  const summary = summarizeVariants(mergedRuns);
  await writeJsonFile(path.join(outputDir, "summary.json"), summary);
  await writeProgress(progressPath, {
    status: "completed",
    completedRuns: runs.length,
    totalRuns,
    currentRunId: null,
    lastFinishedRunId: runs.at(-1)?.runId ?? null,
    startedAt: new Date().toISOString()
  });

  console.log(JSON.stringify(summary, null, 2));
}

function buildVariants(modelName: string, summarizerModel: string, maxContextTokens: number): BenchmarkVariant[] {
  const recentRawWindowTokens = Math.floor(maxContextTokens * 0.65);
  const decayWarmStartTokens = Math.floor(maxContextTokens * 0.8);
  const decayTargetTokens = Math.floor(maxContextTokens * 0.85);
  const decayEmergencyTokens = Math.floor(maxContextTokens * 0.94);

  return [
    {
      id: "baseline",
      modelName,
      systemPrompt: "Solve the task without context compression.",
      compression: {
        mode: "none",
        maxContextTokens,
        compressAtRatio: 0.8,
        phaseCompressionEnabled: false,
        messageDecayEnabled: false,
        maxApiCalls: 60,
        maxRepeatedPromptFingerprints: 4,
        mainTpmLimit: 150000,
        mainTpmReserveTokens: 1400
      }
    },
    {
      id: "tool-only",
      modelName,
      systemPrompt: "Solve the task with selective clearing of older tool outputs but no semantic summarization or decay rewriting.",
      compression: {
        mode: "phase",
        maxContextTokens,
        compressAtRatio: 0.8,
        phaseCompressionEnabled: false,
        toolMicrocompactEnabled: true,
        toolMicrocompactThresholdTokens: Math.floor(maxContextTokens * 0.3),
        toolMicrocompactKeepRecentToolMessages: 4,
        messageDecayEnabled: false,
        keepSuffixMessages: 8,
        retrievalTopK: 1,
        maxApiCalls: 60,
        maxRepeatedPromptFingerprints: 4,
        mainTpmLimit: 150000,
        mainTpmReserveTokens: 1400
      }
    },
    {
      id: "thresholded-hybrid",
      modelName,
      systemPrompt:
        "Solve the task with selective clearing of older tool outputs plus high-pressure decay. Keep the newest 65% of context raw and only decay older tool context after usage passes 80% of the budget, targeting 85%.",
      compression: {
        mode: "hybrid",
        maxContextTokens,
        compressAtRatio: 0.8,
        phaseCompressionEnabled: false,
        toolMicrocompactEnabled: true,
        toolMicrocompactThresholdTokens: Math.floor(maxContextTokens * 0.3),
        toolMicrocompactKeepRecentToolMessages: 4,
        messageDecayEnabled: true,
        keepSuffixMessages: 10,
        decayWarmStartTokens,
        decayTargetTokens,
        recentRawWindowTokens,
        decayEmergencyTokens,
        decayCandidateRoles: ["tool"],
        retrievalTopK: 1,
        maxApiCalls: 70,
        maxRepeatedPromptFingerprints: 4,
        mainTpmLimit: 150000,
        mainTpmReserveTokens: 1400
      }
    }
  ];
}

function assignScenarioBuckets(runs: BenchmarkRunRecord[]): BenchmarkRunRecord[] {
  const baseline = runs
    .filter((run) => run.variantId === "baseline")
    .sort((left, right) => left.peakInputTokens - right.peakInputTokens);

  const bucketLabels = ["scenario-1", "scenario-2", "scenario-3", "scenario-4"];
  const bucketByInstance = new Map<string, string>();

  baseline.forEach((run, index) => {
    const normalized = baseline.length === 0 ? 0 : index / baseline.length;
    const bucketIndex = Math.min(bucketLabels.length - 1, Math.floor(normalized * bucketLabels.length));
    bucketByInstance.set(run.instanceId, bucketLabels[bucketIndex] ?? "scenario-1");
  });

  return runs.map((run) => ({
    ...run,
    scenarioBucket: bucketByInstance.get(run.instanceId) ?? "scenario-1"
  }));
}

function summarizeVariants(runs: BenchmarkRunRecord[]): {
  overall: VariantSummary[];
  byTask: TaskSummary[];
} {
  const variantIds = ["baseline", "tool-only", "thresholded-hybrid"] as const;
  const overall = variantIds.map((variantId) => summarizeVariantRuns(runs.filter((run) => run.variantId === variantId)));
  const runByVariantAndTask = new Map(runs.map((run) => [`${run.variantId}::${run.instanceId}`, run]));
  const taskIds = [...new Set(runs.map((run) => run.instanceId))].sort();

  const byTask = taskIds.map((instanceId) => {
    const sample = runs.find((run) => run.instanceId === instanceId);
    return {
      instanceId,
      repo: sample?.repo ?? "",
      scenarioBucket: sample?.scenarioBucket ?? "scenario-1",
      variants: variantIds.flatMap((variantId) => {
        const run = runByVariantAndTask.get(`${variantId}::${instanceId}`);
        return run ? [summarizeSingleRun(run)] : [];
      })
    };
  });

  return { overall, byTask };
}

function summarizeVariantRuns(runs: BenchmarkRunRecord[]): VariantSummary {
  const usage = sumUsage(runs.map((run) => splitRunUsage(run).main));
  const summaryUsage = sumUsage(runs.map((run) => splitRunUsage(run).summary));
  const totalUsage = sumUsage(runs.map((run) => run.usage));
  return {
    variantId: runs[0]?.variantId ?? "baseline",
    runCount: runs.length,
    resolvedCount: runs.filter((run) => run.resolved).length,
    successRate: runs.length === 0 ? 0 : runs.filter((run) => run.resolved).length / runs.length,
    mainUsage: usage,
    summaryUsage,
    totalUsage,
    mainPeakInputTokens: Math.max(0, ...runs.map((run) => splitRunUsage(run).mainPeakInputTokens)),
    totalPeakInputTokens: Math.max(0, ...runs.map((run) => run.peakInputTokens)),
    mainEstimatedCost: estimateCost(usage),
    summaryEstimatedCost: estimateCost(summaryUsage),
    totalEstimatedCost: estimateCost(totalUsage)
  };
}

function summarizeSingleRun(run: BenchmarkRunRecord): VariantRunSummary {
  const split = splitRunUsage(run);
  const summary: VariantRunSummary = {
    variantId: run.variantId,
    resolved: run.resolved ?? false,
    mainUsage: split.main,
    summaryUsage: split.summary,
    totalUsage: run.usage,
    mainPeakInputTokens: split.mainPeakInputTokens,
    totalPeakInputTokens: run.peakInputTokens,
    mainEstimatedCost: estimateCost(split.main),
    summaryEstimatedCost: estimateCost(split.summary),
    totalEstimatedCost: estimateCost(run.usage)
  };

  const metadata = run.metadata as Record<string, unknown> | undefined;
  const compression = metadata?.compression;
  const apiCalls = numberValue(metadata, "mini_swe_agent_api_calls");
  const archived = numberValue(compression, "archived_count");
  const retrieval = numberValue(compression, "retrieval_count");
  const summaryCalls = numberValue(compression, "summary_call_count");

  if (typeof apiCalls === "number") {
    summary.apiCalls = apiCalls;
  }
  if (typeof archived === "number") {
    summary.archived = archived;
  }
  if (typeof retrieval === "number") {
    summary.retrieval = retrieval;
  }
  if (typeof summaryCalls === "number") {
    summary.summaryCalls = summaryCalls;
  }

  return summary;
}

function splitRunUsage(run: BenchmarkRunRecord): {
  main: UsageTriple;
  summary: UsageTriple;
  mainPeakInputTokens: number;
} {
  if (!Array.isArray(run.turnUsages) || run.turnUsages.length === 0) {
    return {
      main: run.usage,
      summary: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      mainPeakInputTokens: run.peakInputTokens
    };
  }

  const mainTurns = run.turnUsages.filter((entry) => entry.kind !== "summary");
  const summaryTurns = run.turnUsages.filter((entry) => entry.kind === "summary");

  return {
    main: sumUsage(mainTurns),
    summary: sumUsage(summaryTurns),
    mainPeakInputTokens: Math.max(0, ...mainTurns.map((entry) => entry.inputTokens))
  };
}

function sumUsage(values: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>): UsageTriple {
  return values.reduce(
    (accumulator, value) => ({
      inputTokens: accumulator.inputTokens + value.inputTokens,
      outputTokens: accumulator.outputTokens + value.outputTokens,
      totalTokens: accumulator.totalTokens + value.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

function estimateCost(usage: UsageTriple): CostBreakdown {
  const inputCostPer1M = Number(process.env.BENCHMARK_INPUT_COST ?? "0.8");
  const outputCostPer1M = Number(process.env.BENCHMARK_OUTPUT_COST ?? "3.2");
  const inputCost = (usage.inputTokens / 1_000_000) * inputCostPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * outputCostPer1M;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

function numberValue(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        MSWEA_SILENT_STARTUP: "1"
      }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? -1}`));
    });
    child.on("error", reject);
  });
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await readFile(filename, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeProgress(
  filename: string,
  progress: {
    status: "running" | "completed";
    completedRuns: number;
    totalRuns: number;
    currentRunId: string | null;
    lastFinishedRunId: string | null;
    startedAt: string;
  }
): Promise<void> {
  await writeJsonFile(filename, {
    ...progress,
    percentComplete: progress.totalRuns === 0 ? 0 : Number(((progress.completedRuns / progress.totalRuns) * 100).toFixed(1)),
    updatedAt: new Date().toISOString()
  });
}

interface VariantSummary {
  variantId: BenchmarkVariant["id"];
  runCount: number;
  resolvedCount: number;
  successRate: number;
  mainUsage: UsageTriple;
  summaryUsage: UsageTriple;
  totalUsage: UsageTriple;
  mainPeakInputTokens: number;
  totalPeakInputTokens: number;
  mainEstimatedCost: CostBreakdown;
  summaryEstimatedCost: CostBreakdown;
  totalEstimatedCost: CostBreakdown;
}

interface VariantRunSummary {
  variantId: BenchmarkVariant["id"];
  resolved: boolean;
  mainUsage: UsageTriple;
  summaryUsage: UsageTriple;
  totalUsage: UsageTriple;
  mainPeakInputTokens: number;
  totalPeakInputTokens: number;
  mainEstimatedCost: CostBreakdown;
  summaryEstimatedCost: CostBreakdown;
  totalEstimatedCost: CostBreakdown;
  apiCalls?: number;
  archived?: number;
  retrieval?: number;
  summaryCalls?: number;
}

interface TaskSummary {
  instanceId: string;
  repo: string;
  scenarioBucket: string;
  variants: VariantRunSummary[];
}

void main();
