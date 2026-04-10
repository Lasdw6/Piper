import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
  BenchmarkRunRecord,
  BenchmarkTask,
  BenchmarkVariant,
  CostBreakdown,
} from "./benchmark-types.js";
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

interface ProgressRecord {
  status: "running" | "completed";
  completedRuns: number;
  totalRuns: number;
  currentRunId: string | null;
  lastFinishedRunId: string | null;
  startedAt: string;
  repeats: number;
}

interface VariantAggregate {
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
  avgMainTokensPerRun: number;
  avgTotalTokensPerRun: number;
  avgMainCostPerRun: number;
  avgTotalCostPerRun: number;
}

interface PerTaskVariantAggregate extends VariantAggregate {
  instanceId: string;
  repo: string;
}

interface PerRepeatVariantAggregate extends VariantAggregate {
  repeatIndex: number;
}

async function main(): Promise<void> {
  process.loadEnvFile?.();

  const tasksPath = flagValue("--tasks") ?? "data/swebench-lite-long3.tasks.jsonl";
  const outputDir = flagValue("--out") ?? "artifacts/stock-mini-long3x3-r1";
  const python = flagValue("--python") ?? "python";
  const modelName = flagValue("--model") ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";
  const summarizerModel = flagValue("--summarizer-model") ?? process.env.BENCHMARK_SUMMARIZER_MODEL ?? "gpt-4.1-mini";
  const maxContextTokens = Number(flagValue("--max-context-tokens") ?? process.env.BENCHMARK_MAX_CONTEXT_TOKENS ?? "15000");
  const timeoutMs = Number(flagValue("--timeout-ms") ?? process.env.BENCHMARK_RUN_TIMEOUT_MS ?? "2700000");
  const repeats = Number(flagValue("--repeats") ?? "3");

  const tasks = await readJsonlFile<BenchmarkTask>(tasksPath);
  const adapter = new MiniSweAgentAdapter({ pythonExecutable: python, timeoutMs });
  const variants = buildVariants(modelName, summarizerModel, maxContextTokens);
  const partialRunsPath = path.join(outputDir, "runs.partial.jsonl");
  const progressPath = path.join(outputDir, "progress.json");

  await mkdir(outputDir, { recursive: true });

  const runs: BenchmarkRunRecord[] = (await pathExists(partialRunsPath))
    ? await readJsonlFile<BenchmarkRunRecord>(partialRunsPath)
    : [];
  const completedRunIds = new Set(runs.map((run) => run.runId));
  const totalRuns = tasks.length * variants.length * repeats;
  const startedAt = new Date().toISOString();

  await writeProgress(progressPath, {
    status: "running",
    completedRuns: runs.length,
    totalRuns,
    currentRunId: null,
    lastFinishedRunId: runs.at(-1)?.runId ?? null,
    startedAt,
    repeats,
  });

  for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex += 1) {
    for (const task of tasks) {
      for (const variant of variants) {
        const runId = `${variant.id}_r${repeatIndex}_${task.instanceId}`;
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
          startedAt,
          repeats,
        });

        let result;
        try {
          result = await adapter.runTask(task, variant, {
            runId,
            artifactDir: runArtifactDir,
          });
        } catch (error) {
          result = {
            patch: "",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            turnUsages: [],
            summary: error instanceof Error ? error.message : "run failed",
            metadata: {
              run_error: error instanceof Error ? error.message : "run failed",
              repeat_index: repeatIndex,
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
              errorPath: path.join(runArtifactDir, "error.json"),
            },
          };
        }

        const run: BenchmarkRunRecord = {
          runId,
          adapter: adapter.name,
          variantId: variant.id,
          instanceId: task.instanceId,
          repo: task.repo,
          modelName: variant.modelName,
          evaluationModelName: `${variant.modelName}__${variant.id}__r${repeatIndex}`,
          patch: result.patch,
          usage: result.usage,
          turnUsages: result.turnUsages ?? [],
          peakInputTokens: Math.max(0, ...(result.turnUsages ?? []).map((entry) => entry.inputTokens)),
          metadata: {
            ...(result.metadata ?? {}),
            repeat_index: repeatIndex,
          },
        };

        if (result.summary !== undefined) {
          run.summary = result.summary;
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
          startedAt,
          repeats,
        });
        console.log(
          `[${runs.length}/${totalRuns}] finished ${runId} ` +
            `tokens=${run.usage.totalTokens} peak=${run.peakInputTokens} summary=${run.summary ?? ""}`
        );
      }
    }
  }

  await writeJsonlFile(path.join(outputDir, "runs.jsonl"), runs);

  for (const variant of variants) {
    await writeJsonlFile(
      path.join(outputDir, `${variant.id}.predictions.jsonl`),
      runs
        .filter((run) => run.variantId === variant.id)
        .map((run) => ({
          instance_id: run.instanceId,
          model_name_or_path: run.evaluationModelName,
          model_patch: run.patch,
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
        path.join(outputDir, `${variant.id}.eval.jsonl`),
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
  const mergedRuns = runs.map((run) => ({
    ...run,
    resolved: resolvedByKey.get(`${run.evaluationModelName}::${run.instanceId}`) ?? false,
  }));

  await writeJsonlFile(path.join(outputDir, "runs.with-eval.jsonl"), mergedRuns);
  const summary = summarizeRepeatedRuns(mergedRuns, repeats);
  await writeJsonFile(path.join(outputDir, "summary.json"), summary);
  await writeProgress(progressPath, {
    status: "completed",
    completedRuns: runs.length,
    totalRuns,
    currentRunId: null,
    lastFinishedRunId: runs.at(-1)?.runId ?? null,
    startedAt,
    repeats,
  });

  console.log(JSON.stringify(summary, null, 2));
}

function buildVariants(modelName: string, summarizerModel: string, maxContextTokens: number): BenchmarkVariant[] {
  const recentRawWindowTokens = Math.floor(maxContextTokens * 0.9);
  const decayWarmStartTokens = Math.floor(maxContextTokens * 0.94);
  const decayTargetTokens = Math.floor(maxContextTokens * 0.95);
  const decayEmergencyTokens = Math.floor(maxContextTokens * 0.98);
  const toolMicrocompactThresholdTokens = decayWarmStartTokens;

  return [
    {
      id: "baseline",
      modelName,
      systemPrompt: "",
    },
    {
      id: "thresholded-hybrid",
      modelName,
      summarizerModel,
      systemPrompt: "",
      compression: {
        mode: "hybrid",
        maxContextTokens,
        compressAtRatio: 0.8,
        summarizerModel,
        phaseCompressionEnabled: false,
        toolMicrocompactEnabled: true,
        toolMicrocompactThresholdTokens,
        toolMicrocompactKeepRecentToolMessages: 24,
        toolMicrocompactMinMessageTokens: 160,
        toolMicrocompactMinMessageChars: 900,
        messageDecayEnabled: true,
        keepSuffixMessages: 22,
        decayWarmStartTokens,
        decayTargetTokens,
        recentRawWindowTokens,
        decayEmergencyTokens,
        decayCandidateRoles: ["tool"],
        retrievalTopK: 1,
        maxApiCalls: 70,
        maxRepeatedPromptFingerprints: 4,
        mainTpmLimit: 150000,
        mainTpmReserveTokens: 1400,
      },
    },
  ];
}

function summarizeRepeatedRuns(
  runs: BenchmarkRunRecord[],
  repeats: number
): {
  config: { repeats: number; taskCount: number; runCount: number; runner: string };
  overall: VariantAggregate[];
  byRepeat: PerRepeatVariantAggregate[];
  byTask: PerTaskVariantAggregate[];
  comparison: {
    pairCount: number;
    baselineSuccessRate: number;
    hybridSuccessRate: number;
    successDelta: number;
    baselineAvgTotalCostPerRun: number;
    hybridAvgTotalCostPerRun: number;
    baselineAvgMainTokensPerRun: number;
    hybridAvgMainTokensPerRun: number;
    hybridMainTokenReductionRate: number;
  };
} {
  const variantIds: BenchmarkVariant["id"][] = ["baseline", "thresholded-hybrid"];
  const overall = variantIds.map((variantId) => summarizeVariantRuns(runs.filter((run) => run.variantId === variantId)));

  const byRepeat: PerRepeatVariantAggregate[] = [];
  for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex += 1) {
    for (const variantId of variantIds) {
      const aggregate = summarizeVariantRuns(
        runs.filter((run) => run.variantId === variantId && repeatIndexOf(run) === repeatIndex)
      ) as PerRepeatVariantAggregate;
      aggregate.repeatIndex = repeatIndex;
      byRepeat.push(aggregate);
    }
  }

  const byTask: PerTaskVariantAggregate[] = [];
  const instanceIds = [...new Set(runs.map((run) => run.instanceId))].sort();
  for (const instanceId of instanceIds) {
    for (const variantId of variantIds) {
      const taskRuns = runs.filter((run) => run.instanceId === instanceId && run.variantId === variantId);
      if (taskRuns.length === 0) {
        continue;
      }
      const aggregate = summarizeVariantRuns(taskRuns) as PerTaskVariantAggregate;
      aggregate.instanceId = instanceId;
      aggregate.repo = taskRuns[0]?.repo ?? "";
      byTask.push(aggregate);
    }
  }

  const baseline = overall.find((row) => row.variantId === "baseline");
  const hybrid = overall.find((row) => row.variantId === "thresholded-hybrid");
  const taskCount = instanceIds.length;
  const pairCount = taskCount * repeats;

  return {
    config: { repeats, taskCount, runCount: runs.length, runner: "stock-mini-long3-repeat" },
    overall,
    byRepeat,
    byTask,
    comparison: {
      pairCount,
      baselineSuccessRate: baseline?.successRate ?? 0,
      hybridSuccessRate: hybrid?.successRate ?? 0,
      successDelta: (hybrid?.successRate ?? 0) - (baseline?.successRate ?? 0),
      baselineAvgTotalCostPerRun: baseline?.avgTotalCostPerRun ?? 0,
      hybridAvgTotalCostPerRun: hybrid?.avgTotalCostPerRun ?? 0,
      baselineAvgMainTokensPerRun: baseline?.avgMainTokensPerRun ?? 0,
      hybridAvgMainTokensPerRun: hybrid?.avgMainTokensPerRun ?? 0,
      hybridMainTokenReductionRate:
        baseline && baseline.avgMainTokensPerRun > 0
          ? 1 - (hybrid?.avgMainTokensPerRun ?? 0) / baseline.avgMainTokensPerRun
          : 0,
    },
  };
}

function summarizeVariantRuns(runs: BenchmarkRunRecord[]): VariantAggregate {
  const mainUsage = sumUsage(runs.map((run) => splitRunUsage(run).main));
  const summaryUsage = sumUsage(runs.map((run) => splitRunUsage(run).summary));
  const totalUsage = sumUsage(runs.map((run) => run.usage));
  const resolvedCount = runs.filter((run) => run.resolved).length;
  const runCount = runs.length;
  const mainEstimatedCost = estimateCost(mainUsage, "main");
  const summaryEstimatedCost = estimateCost(summaryUsage, "summary");
  const totalEstimatedCost: CostBreakdown = {
    inputCost: mainEstimatedCost.inputCost + summaryEstimatedCost.inputCost,
    outputCost: mainEstimatedCost.outputCost + summaryEstimatedCost.outputCost,
    totalCost: mainEstimatedCost.totalCost + summaryEstimatedCost.totalCost,
  };

  return {
    variantId: runs[0]?.variantId ?? "baseline",
    runCount,
    resolvedCount,
    successRate: runCount > 0 ? resolvedCount / runCount : 0,
    mainUsage,
    summaryUsage,
    totalUsage,
    mainPeakInputTokens: Math.max(0, ...runs.map((run) => splitRunUsage(run).mainPeakInputTokens)),
    totalPeakInputTokens: Math.max(0, ...runs.map((run) => run.peakInputTokens ?? 0)),
    mainEstimatedCost,
    summaryEstimatedCost,
    totalEstimatedCost,
    avgMainTokensPerRun: runCount > 0 ? mainUsage.totalTokens / runCount : 0,
    avgTotalTokensPerRun: runCount > 0 ? totalUsage.totalTokens / runCount : 0,
    avgMainCostPerRun: runCount > 0 ? mainEstimatedCost.totalCost / runCount : 0,
    avgTotalCostPerRun: runCount > 0 ? totalEstimatedCost.totalCost / runCount : 0,
  };
}

function repeatIndexOf(run: BenchmarkRunRecord): number {
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const value = metadata?.repeat_index;
  return typeof value === "number" ? value : Number(value ?? 0);
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
      mainPeakInputTokens: run.peakInputTokens,
    };
  }

  const mainTurns = run.turnUsages.filter((entry) => entry.kind !== "summary");
  const summaryTurns = run.turnUsages.filter((entry) => entry.kind === "summary");

  return {
    main: sumUsage(mainTurns),
    summary: sumUsage(summaryTurns),
    mainPeakInputTokens: Math.max(0, ...mainTurns.map((entry) => entry.inputTokens)),
  };
}

function sumUsage(values: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>): UsageTriple {
  return values.reduce(
    (accumulator, value) => ({
      inputTokens: accumulator.inputTokens + value.inputTokens,
      outputTokens: accumulator.outputTokens + value.outputTokens,
      totalTokens: accumulator.totalTokens + value.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

function estimateCost(usage: UsageTriple, kind: "main" | "summary"): CostBreakdown {
  const mainInputRate = Number(process.env.BENCHMARK_MAIN_INPUT_COST ?? "1.25");
  const mainOutputRate = Number(process.env.BENCHMARK_MAIN_OUTPUT_COST ?? "10");
  const summaryInputRate = Number(process.env.BENCHMARK_SUMMARY_INPUT_COST ?? "0.3");
  const summaryOutputRate = Number(process.env.BENCHMARK_SUMMARY_OUTPUT_COST ?? "2.4");
  const inputRate = kind === "summary" ? summaryInputRate : mainInputRate;
  const outputRate = kind === "summary" ? summaryOutputRate : mainOutputRate;
  const inputCost = (usage.inputTokens / 1_000_000) * inputRate;
  const outputCost = (usage.outputTokens / 1_000_000) * outputRate;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
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
        MSWEA_SILENT_STARTUP: "1",
      },
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

async function writeProgress(filename: string, progress: ProgressRecord): Promise<void> {
  await writeJsonFile(filename, {
    ...progress,
    percentComplete:
      progress.totalRuns === 0 ? 0 : Number(((progress.completedRuns / progress.totalRuns) * 100).toFixed(1)),
    updatedAt: new Date().toISOString(),
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
