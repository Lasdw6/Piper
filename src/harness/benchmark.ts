import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  AgentAdapter,
  AggregateMetrics,
  BenchmarkRunRecord,
  BenchmarkSummary,
  BenchmarkTask,
  BenchmarkVariant,
  ComparisonMetrics,
  CostBreakdown,
  EvaluationRecord,
  PricingConfig,
  SweBenchPrediction
} from "./benchmark-types.js";
import { readJsonlFile, writeJsonFile, writeJsonlFile } from "./jsonl.js";

export class BenchmarkRunner {
  constructor(
    private readonly adapter: AgentAdapter,
    private readonly pricing: PricingConfig
  ) {}

  async runPaired(tasks: BenchmarkTask[], outputDir: string, variants: [BenchmarkVariant, BenchmarkVariant]): Promise<BenchmarkRunRecord[]> {
    await mkdir(outputDir, { recursive: true });

    const runs: BenchmarkRunRecord[] = [];
    for (const task of tasks) {
      for (const variant of variants) {
        const runId = `${variant.id}_${task.instanceId}`;
        const result = await this.adapter.runTask(task, variant, {
          runId,
          artifactDir: path.join(outputDir, "runs", runId)
        });
        const turnUsages = result.turnUsages ?? [];
        const run: BenchmarkRunRecord = {
          runId,
          adapter: this.adapter.name,
          variantId: variant.id,
          instanceId: task.instanceId,
          repo: task.repo,
          modelName: variant.modelName,
          evaluationModelName: toEvaluationModelName(variant),
          patch: result.patch,
          usage: result.usage,
          turnUsages,
          peakInputTokens: Math.max(0, ...turnUsages.map((entry) => entry.inputTokens))
        };

        if (result.summary !== undefined) {
          run.summary = result.summary;
        }
        if (result.resolved !== undefined) {
          run.resolved = result.resolved;
        }

        if (result.metadata !== undefined) {
          run.metadata = result.metadata;
        }
        if (result.artifacts !== undefined) {
          run.artifacts = result.artifacts;
        }

        runs.push(run);
      }
    }

    const bucketed = assignScenarioBuckets(runs);
    await writeJsonlFile(path.join(outputDir, "runs.jsonl"), bucketed);
    await writeJsonlFile(path.join(outputDir, "baseline.predictions.jsonl"), toPredictions(bucketed, "baseline"));
    await writeJsonlFile(path.join(outputDir, "compressed.predictions.jsonl"), toPredictions(bucketed, "compressed"));
    await writeJsonFile(path.join(outputDir, "summary.pre-eval.json"), summarizeRuns(bucketed, this.pricing));
    return bucketed;
  }

  async mergeEvaluation(runsPath: string, evaluationPath: string, outputDir: string): Promise<BenchmarkSummary> {
    const runs = await readJsonlFile<BenchmarkRunRecord>(runsPath);
    const evaluations = await readJsonlFile<EvaluationRecord>(evaluationPath);
    const resolvedByKey = new Map(
      evaluations.map((record) => [`${record.model_name_or_path}::${record.instance_id}`, record.resolved])
    );

    const merged = runs.map((run) => ({
      ...run,
      resolved: resolvedByKey.get(`${run.evaluationModelName}::${run.instanceId}`) ?? run.resolved ?? false
    }));

    await mkdir(outputDir, { recursive: true });
    await writeJsonlFile(path.join(outputDir, "runs.with-eval.jsonl"), merged);

    const summary = summarizeRuns(merged, this.pricing);
    await writeJsonFile(path.join(outputDir, "summary.post-eval.json"), summary);
    return summary;
  }
}

export function summarizeRuns(runs: BenchmarkRunRecord[], pricing: PricingConfig): BenchmarkSummary {
  const overall = compareGroupedRuns(runs, pricing, "overall");
  const scenarios = [...new Set(runs.map((run) => run.scenarioBucket).filter((value): value is string => value !== undefined))];

  return {
    overall,
    byScenario: scenarios.map((scenario) =>
      compareGroupedRuns(
        runs.filter((run) => run.scenarioBucket === scenario),
        pricing,
        scenario
      )
    )
  };
}

function compareGroupedRuns(runs: BenchmarkRunRecord[], pricing: PricingConfig, label: string): ComparisonMetrics {
  const baseline = runs.filter((run) => run.variantId === "baseline");
  const compressed = runs.filter((run) => run.variantId === "compressed");
  const pairs = pairRunsByInstance(baseline, compressed);

  const baselineAggregate = aggregateRuns(pairs.map((pair) => pair.baseline), pricing, `${label}:baseline`);
  const compressedAggregate = aggregateRuns(pairs.map((pair) => pair.compressed), pricing, `${label}:compressed`);

  return {
    label,
    pairCount: pairs.length,
    baselineSuccessRate: baselineAggregate.successRate,
    compressedSuccessRate: compressedAggregate.successRate,
    successDelta: compressedAggregate.successRate - baselineAggregate.successRate,
    baselineTotalTokens: baselineAggregate.totalTokens,
    compressedTotalTokens: compressedAggregate.totalTokens,
    tokenReductionRate: ratioReduction(baselineAggregate.totalTokens, compressedAggregate.totalTokens),
    baselinePeakInputTokens: baselineAggregate.peakInputTokens,
    compressedPeakInputTokens: compressedAggregate.peakInputTokens,
    peakReductionRate: ratioReduction(baselineAggregate.peakInputTokens, compressedAggregate.peakInputTokens),
    baselineEstimatedCost: baselineAggregate.estimatedCost,
    compressedEstimatedCost: compressedAggregate.estimatedCost,
    baselineMainInputTokens: baselineAggregate.mainInputTokens,
    baselineMainOutputTokens: baselineAggregate.mainOutputTokens,
    baselineMainTokens: baselineAggregate.mainTotalTokens,
    compressedMainInputTokens: compressedAggregate.mainInputTokens,
    compressedMainOutputTokens: compressedAggregate.mainOutputTokens,
    compressedMainTokens: compressedAggregate.mainTotalTokens,
    mainTokenReductionRate: ratioReduction(baselineAggregate.mainTotalTokens, compressedAggregate.mainTotalTokens),
    baselineSummaryInputTokens: baselineAggregate.summaryInputTokens,
    baselineSummaryOutputTokens: baselineAggregate.summaryOutputTokens,
    baselineSummaryTokens: baselineAggregate.summaryTotalTokens,
    compressedSummaryInputTokens: compressedAggregate.summaryInputTokens,
    compressedSummaryOutputTokens: compressedAggregate.summaryOutputTokens,
    compressedSummaryTokens: compressedAggregate.summaryTotalTokens,
    baselineMainPeakInputTokens: baselineAggregate.mainPeakInputTokens,
    compressedMainPeakInputTokens: compressedAggregate.mainPeakInputTokens,
    mainPeakReductionRate: ratioReduction(
      baselineAggregate.mainPeakInputTokens,
      compressedAggregate.mainPeakInputTokens
    ),
    baselineMainEstimatedCost: baselineAggregate.mainEstimatedCost,
    compressedMainEstimatedCost: compressedAggregate.mainEstimatedCost,
    baselineSummaryEstimatedCost: baselineAggregate.summaryEstimatedCost,
    compressedSummaryEstimatedCost: compressedAggregate.summaryEstimatedCost
  };
}

function aggregateRuns(runs: BenchmarkRunRecord[], pricing: PricingConfig, label: string): AggregateMetrics {
  const resolvedCount = runs.filter((run) => run.resolved === true).length;
  const totalInputTokens = sum(runs.map((run) => run.usage.inputTokens));
  const totalOutputTokens = sum(runs.map((run) => run.usage.outputTokens));
  const totalTokens = sum(runs.map((run) => run.usage.totalTokens));
  const peakInputTokens = Math.max(0, ...runs.map((run) => run.peakInputTokens));
  const breakdowns = runs.map((run) => splitRunUsage(run));
  const mainInputTokens = sum(breakdowns.map((item) => item.main.inputTokens));
  const mainOutputTokens = sum(breakdowns.map((item) => item.main.outputTokens));
  const mainTotalTokens = sum(breakdowns.map((item) => item.main.totalTokens));
  const summaryInputTokens = sum(breakdowns.map((item) => item.summary.inputTokens));
  const summaryOutputTokens = sum(breakdowns.map((item) => item.summary.outputTokens));
  const summaryTotalTokens = sum(breakdowns.map((item) => item.summary.totalTokens));
  const mainPeakInputTokens = Math.max(0, ...breakdowns.map((item) => item.mainPeakInputTokens));

  return {
    label,
    runCount: runs.length,
    resolvedCount,
    successRate: runs.length === 0 ? 0 : resolvedCount / runs.length,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    peakInputTokens,
    estimatedCost: estimateCost({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens }, pricing),
    mainInputTokens,
    mainOutputTokens,
    mainTotalTokens,
    summaryInputTokens,
    summaryOutputTokens,
    summaryTotalTokens,
    mainPeakInputTokens,
    mainEstimatedCost: estimateCost(
      { inputTokens: mainInputTokens, outputTokens: mainOutputTokens, totalTokens: mainTotalTokens },
      pricing
    ),
    summaryEstimatedCost: estimateCost(
      { inputTokens: summaryInputTokens, outputTokens: summaryOutputTokens, totalTokens: summaryTotalTokens },
      pricing
    )
  };
}

export function estimateCost(
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  pricing: PricingConfig
): CostBreakdown {
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
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
    bucketByInstance.set(run.instanceId, bucketLabels[bucketIndex] ?? bucketLabels[0] ?? "scenario-1");
  });

  return runs.map((run) => ({
    ...run,
    scenarioBucket: bucketByInstance.get(run.instanceId) ?? "scenario-1"
  }));
}

function toPredictions(runs: BenchmarkRunRecord[], variantId: "baseline" | "compressed"): SweBenchPrediction[] {
  return runs
    .filter((run) => run.variantId === variantId)
    .map((run) => ({
      instance_id: run.instanceId,
      model_name_or_path: run.evaluationModelName,
      model_patch: run.patch
    }));
}

function toEvaluationModelName(variant: BenchmarkVariant): string {
  return `${variant.modelName}__${variant.id}`;
}

function pairRunsByInstance(
  baseline: BenchmarkRunRecord[],
  compressed: BenchmarkRunRecord[]
): Array<{ baseline: BenchmarkRunRecord; compressed: BenchmarkRunRecord }> {
  const compressedByInstance = new Map(compressed.map((run) => [run.instanceId, run]));
  return baseline.flatMap((run) => {
    const partner = compressedByInstance.get(run.instanceId);
    return partner ? [{ baseline: run, compressed: partner }] : [];
  });
}

function ratioReduction(baseline: number, candidate: number): number {
  if (baseline <= 0) {
    return 0;
  }

  return 1 - candidate / baseline;
}

function sum(values: number[]): number {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

function splitRunUsage(run: BenchmarkRunRecord): {
  main: { inputTokens: number; outputTokens: number; totalTokens: number };
  summary: { inputTokens: number; outputTokens: number; totalTokens: number };
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

function sumUsage(
  values: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  return values.reduce(
    (accumulator, value) => ({
      inputTokens: accumulator.inputTokens + value.inputTokens,
      outputTokens: accumulator.outputTokens + value.outputTokens,
      totalTokens: accumulator.totalTokens + value.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}
