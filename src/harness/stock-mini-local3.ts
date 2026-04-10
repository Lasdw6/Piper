import { mkdir } from "node:fs/promises";
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

async function main(): Promise<void> {
  process.loadEnvFile?.();

  const tasksPath = flagValue("--tasks") ?? "data/swebench-lite-local3.tasks.jsonl";
  const outputDir = flagValue("--out") ?? "artifacts/stock-mini-local3";
  const python = flagValue("--python") ?? "python";
  const modelName = flagValue("--model") ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";
  const summarizerModel = flagValue("--summarizer-model") ?? process.env.BENCHMARK_SUMMARIZER_MODEL ?? "gpt-4.1-mini";
  const maxContextTokens = Number(flagValue("--max-context-tokens") ?? process.env.BENCHMARK_MAX_CONTEXT_TOKENS ?? "20000");
  const timeoutMs = Number(flagValue("--timeout-ms") ?? process.env.BENCHMARK_RUN_TIMEOUT_MS ?? "1800000");

  await mkdir(outputDir, { recursive: true });
  const tasks = await readJsonlFile<BenchmarkTask>(tasksPath);
  const adapter = new MiniSweAgentAdapter({ pythonExecutable: python, timeoutMs });
  const variants = buildVariants(modelName, summarizerModel, maxContextTokens);

  const runs: BenchmarkRunRecord[] = [];
  let runIndex = 0;

  for (const task of tasks) {
    for (const variant of variants) {
      runIndex += 1;
      const runId = `${variant.id}_${task.instanceId}`;
      const runArtifactDir = path.join(outputDir, "runs", runId);
      console.log(`[${runIndex}/${tasks.length * variants.length}] starting ${runId}`);
      const result = await adapter.runTask(task, variant, {
        runId,
        artifactDir: runArtifactDir,
      });

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
        peakInputTokens: Math.max(0, ...(result.turnUsages ?? []).map((entry) => entry.inputTokens)),
        metadata: result.metadata ?? {},
      };
      if (result.summary !== undefined) {
        run.summary = result.summary;
      }
      if (result.artifacts !== undefined) {
        run.artifacts = result.artifacts;
      }

      runs.push(run);
      console.log(
        `[${runIndex}/${tasks.length * variants.length}] finished ${runId} ` +
          `tokens=${run.usage.totalTokens} peak=${run.peakInputTokens} summary=${run.summary ?? ""}`
      );
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
  await writeJsonFile(path.join(outputDir, "summary.json"), summarizeRuns(mergedRuns));
  console.log(JSON.stringify(summarizeRuns(mergedRuns), null, 2));
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

function summarizeRuns(runs: BenchmarkRunRecord[]) {
  const overall = (["baseline", "thresholded-hybrid"] as const).map((variantId) =>
    summarizeVariantRuns(runs.filter((run) => run.variantId === variantId))
  );
  const baseline = overall.find((row) => row.variantId === "baseline");
  const hybrid = overall.find((row) => row.variantId === "thresholded-hybrid");

  return {
    config: {
      taskCount: new Set(runs.map((run) => run.instanceId)).size,
      runCount: runs.length,
      runner: "stock-mini-local3",
    },
    overall,
    comparison: {
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
  const mainUsage = sumUsage(runs, "response");
  const summaryUsage = sumUsage(runs, "summary");
  const totalUsage: UsageTriple = {
    inputTokens: mainUsage.inputTokens + summaryUsage.inputTokens,
    outputTokens: mainUsage.outputTokens + summaryUsage.outputTokens,
    totalTokens: mainUsage.totalTokens + summaryUsage.totalTokens,
  };

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
    mainPeakInputTokens: Math.max(0, ...runs.map((run) => peakInputTokens(run, "response"))),
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

function sumUsage(runs: BenchmarkRunRecord[], kind: "response" | "summary"): UsageTriple {
  const turnEntries = runs.flatMap((run) => (run.turnUsages ?? []).filter((entry) => entry.kind === kind));
  return {
    inputTokens: turnEntries.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: turnEntries.reduce((sum, entry) => sum + entry.outputTokens, 0),
    totalTokens: turnEntries.reduce((sum, entry) => sum + entry.totalTokens, 0),
  };
}

function peakInputTokens(run: BenchmarkRunRecord, kind: "response" | "summary"): number {
  return Math.max(0, ...((run.turnUsages ?? []).filter((entry) => entry.kind === kind).map((entry) => entry.inputTokens)));
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

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        MSWEA_SILENT_STARTUP: "1",
      },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? -1}`))));
    child.on("error", reject);
  });
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
