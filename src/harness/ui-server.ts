import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import type { BenchmarkRunRecord, BenchmarkSummary, CostBreakdown, EvaluationRecord } from "./benchmark-types.js";
import { readJsonlFile } from "./jsonl.js";

const rootDir = process.cwd();
const artifactsDir = path.join(rootDir, "artifacts");
const uiDir = path.join(rootDir, "ui");
const port = Number(process.env.UI_PORT ?? process.argv[2] ?? "4310");
const mainPricing = {
  inputCostPer1M: Number(process.env.BENCHMARK_MAIN_INPUT_COST ?? process.env.BENCHMARK_INPUT_COST ?? "0.8"),
  outputCostPer1M: Number(process.env.BENCHMARK_MAIN_OUTPUT_COST ?? process.env.BENCHMARK_OUTPUT_COST ?? "3.2")
};
const summaryPricing = {
  inputCostPer1M: Number(process.env.BENCHMARK_SUMMARY_INPUT_COST ?? process.env.BENCHMARK_INPUT_COST ?? "0.8"),
  outputCostPer1M: Number(process.env.BENCHMARK_SUMMARY_OUTPUT_COST ?? process.env.BENCHMARK_OUTPUT_COST ?? "3.2")
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === "/api/benchmarks") {
      await writeJson(response, 200, await listBenchmarks());
      return;
    }

    if (url.pathname === "/api/benchmark") {
      const id = url.searchParams.get("id");
      if (!id) {
        await writeJson(response, 400, { error: "Missing benchmark id" });
        return;
      }

      await writeJson(response, 200, await loadBenchmark(id));
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    await writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
}).listen(port, () => {
  console.log(`Benchmark UI available at http://localhost:${port}`);
});

async function listBenchmarks(): Promise<BenchmarkListItem[]> {
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  const items: BenchmarkListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const benchmarkDir = path.join(artifactsDir, entry.name);
    const summaryPostPath = path.join(benchmarkDir, "summary.post-eval.json");
    const summaryPrePath = path.join(benchmarkDir, "summary.pre-eval.json");
    const runsPath = path.join(benchmarkDir, "runs.jsonl");
    const partialRunsPath = path.join(benchmarkDir, "runs.partial.jsonl");
    const progressPath = path.join(benchmarkDir, "progress.json");
    const hasPost = await exists(summaryPostPath);
    const hasPre = await exists(summaryPrePath);
    const hasRuns = await exists(runsPath);
    const hasPartialRuns = await exists(partialRunsPath);
    const progress = (await exists(progressPath))
      ? (JSON.parse(await readFile(progressPath, "utf8")) as ProgressSnapshot)
      : undefined;

    if (!hasRuns && !hasPartialRuns) {
      continue;
    }

    const directoryStats = await stat(benchmarkDir);
    const runs = await loadRuns(path.join(benchmarkDir, "runs.with-eval.jsonl"), runsPath, benchmarkDir, partialRunsPath);
    const summary = runs.length > 0 ? buildUiSummary(runs).overall : undefined;

    const item: BenchmarkListItem = {
      id: entry.name,
      label: entry.name,
      status: progress?.status === "running" ? "running" : hasPost ? "post-eval" : "pre-eval",
      updatedAt: directoryStats.mtime.toISOString()
    };

    if (summary) {
      item.overall = {
        pairCount: summary.pairCount,
        baselineSuccessRate: summary.baselineSuccessRate,
        compressedSuccessRate: summary.compressedSuccessRate,
        tokenReductionRate: summary.mainTokenReductionRate,
        peakReductionRate: summary.peakReductionRate,
        baselineCost: summary.baselineMainCost.totalCost,
        compressedCost: summary.compressedMainCost.totalCost,
        baselineSummaryTokens: summary.baselineSummaryTokens,
        compressedSummaryTokens: summary.compressedSummaryTokens,
        baselineSummaryCost: summary.baselineSummaryCost.totalCost,
        compressedSummaryCost: summary.compressedSummaryCost.totalCost
      };
    }

    if (progress) {
      item.progress = progress;
    }

    items.push(item);
  }

  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadBenchmark(id: string): Promise<BenchmarkDetail> {
  assertSafeId(id);
  const benchmarkDir = path.join(artifactsDir, id);
  const runsPath = path.join(benchmarkDir, "runs.with-eval.jsonl");
  const rawRunsPath = path.join(benchmarkDir, "runs.jsonl");
  const partialRunsPath = path.join(benchmarkDir, "runs.partial.jsonl");
  const progressPath = path.join(benchmarkDir, "progress.json");
  const summaryPostPath = path.join(benchmarkDir, "summary.post-eval.json");
  const summaryPrePath = path.join(benchmarkDir, "summary.pre-eval.json");

  const runs = await loadRuns(runsPath, rawRunsPath, benchmarkDir, partialRunsPath);
  const progress = (await exists(progressPath))
    ? (JSON.parse(await readFile(progressPath, "utf8")) as ProgressSnapshot)
    : undefined;
  const perTask = toPerTask(runs);
  const comparison = buildComparisonSeries(runs);
  const summary = runs.length > 0 ? buildUiSummary(runs) : undefined;
  const directoryStats = await stat(benchmarkDir);

  const detail: BenchmarkDetail = {
    id,
    label: id,
    updatedAt: directoryStats.mtime.toISOString(),
    status: progress?.status === "running" ? "running" : (await exists(summaryPostPath)) ? "post-eval" : "pre-eval",
    tasks: perTask,
    comparison
  };

  if (progress) {
    detail.live = buildLiveView(runs, progress);
  }

  if (summary) {
    detail.summary = summary;
  }

  return detail;
}

async function loadRuns(
  mergedRunsPath: string,
  rawRunsPath: string,
  benchmarkDir: string,
  partialRunsPath?: string
): Promise<BenchmarkRunRecord[]> {
  if (await exists(mergedRunsPath)) {
    return readJsonlFile<BenchmarkRunRecord>(mergedRunsPath);
  }

  if (!(await exists(rawRunsPath)) && partialRunsPath && (await exists(partialRunsPath))) {
    return readJsonlFile<BenchmarkRunRecord>(partialRunsPath);
  }

  const runs = await readJsonlFile<BenchmarkRunRecord>(rawRunsPath);
  const evaluations = await loadEvaluations(benchmarkDir);
  if (evaluations.length === 0) {
    return runs;
  }

  const resolvedByKey = new Map(
    evaluations.map((record) => [`${record.model_name_or_path}::${record.instance_id}`, record.resolved])
  );

  return runs.map((run) => ({
    ...run,
    resolved: resolvedByKey.get(`${run.evaluationModelName}::${run.instanceId}`) ?? run.resolved ?? false
  }));
}

function buildLiveView(runs: BenchmarkRunRecord[], progress: ProgressSnapshot): LiveBenchmarkView {
  const tasks = new Map<string, LiveTaskView>();

  for (const run of runs) {
    const task = tasks.get(run.instanceId) ?? {
      instanceId: run.instanceId,
      repo: run.repo,
      variants: []
    };

    task.variants.push({
      variantId: run.variantId,
      runId: run.runId,
      totalTokens: run.usage.totalTokens,
      peakInputTokens: run.peakInputTokens,
      submissionStatus:
        typeof run.metadata?.submission_exit_status === "string"
          ? run.metadata.submission_exit_status
          : run.summary ?? ""
    });
    if (typeof run.resolved === "boolean") {
      const latestVariant = task.variants.at(-1);
      if (latestVariant) {
        latestVariant.resolved = run.resolved;
      }
    }
    tasks.set(run.instanceId, task);
  }

  return {
    progress,
    tasks: [...tasks.values()].sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  };
}

async function loadEvaluations(benchmarkDir: string): Promise<EvaluationRecord[]> {
  const files = ["baseline.eval.jsonl", "compressed.eval.jsonl", "all.eval.jsonl"];
  const records: EvaluationRecord[] = [];

  for (const filename of files) {
    const fullPath = path.join(benchmarkDir, filename);
    if (!(await exists(fullPath))) {
      continue;
    }

    const rows = await readJsonlFile<EvaluationRecord>(fullPath);
    records.push(...rows);
  }

  return records;
}

function toPerTask(runs: BenchmarkRunRecord[]): TaskComparison[] {
  const baseline = runs.filter((run) => run.variantId === "baseline");
  const compressedById = new Map(selectCompressedRuns(runs).map((run) => [run.instanceId, run]));

  return baseline
    .flatMap((baseRun) => {
      const compressedRun = compressedById.get(baseRun.instanceId);
      if (!compressedRun) {
        return [];
      }

      return [
        {
          instanceId: baseRun.instanceId,
          repo: baseRun.repo,
          scenarioBucket: baseRun.scenarioBucket ?? compressedRun.scenarioBucket ?? "scenario-1",
          baseline: toVariantTaskView(baseRun),
          compressed: toVariantTaskView(compressedRun),
          tokenReductionRate: ratioReduction(getUsageBreakdown(baseRun).main.totalTokens, getUsageBreakdown(compressedRun).main.totalTokens),
          inputReductionRate: ratioReduction(getUsageBreakdown(baseRun).main.inputTokens, getUsageBreakdown(compressedRun).main.inputTokens),
          peakReductionRate: ratioReduction(getUsageBreakdown(baseRun).mainPeakInputTokens, getUsageBreakdown(compressedRun).mainPeakInputTokens),
          costReductionRate: ratioReduction(
            estimateCost(getUsageBreakdown(baseRun).main, mainPricing).totalCost,
            estimateCost(getUsageBreakdown(compressedRun).main, mainPricing).totalCost
          )
        }
      ];
    })
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

function toVariantTaskView(run: BenchmarkRunRecord): VariantTaskView {
  const usage = getUsageBreakdown(run);
  const view: VariantTaskView = {
    runId: run.runId,
    resolved: run.resolved ?? false,
    inputTokens: usage.main.inputTokens,
    outputTokens: usage.main.outputTokens,
    totalTokens: usage.main.totalTokens,
    peakInputTokens: usage.mainPeakInputTokens,
    cost: estimateCost(usage.main, mainPricing)
  };

  if (usage.summary.totalTokens > 0) {
    view.summaryUsage = usage.summary;
    view.summaryCost = estimateCost(usage.summary, summaryPricing);
  }

  if (run.summary) {
    view.summary = run.summary;
  }

  if (typeof run.metadata?.submission_exit_status === "string") {
    view.submissionStatus = run.metadata.submission_exit_status;
  }

  if (typeof run.metadata?.mini_swe_agent_api_calls === "number") {
    view.apiCalls = run.metadata.mini_swe_agent_api_calls;
  }

  if (Array.isArray(run.turnUsages) && run.turnUsages.length > 0) {
    view.turns = run.turnUsages.map((turn) => ({
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      kind: turn.kind
    }));
  }

  if (run.variantId === "compressed" && typeof run.metadata?.compression === "object" && run.metadata.compression) {
    const compression: NonNullable<VariantTaskView["compression"]> = {};
    const archivedCount = numberValue(run.metadata.compression, "archived_count");
    const retrievalCount = numberValue(run.metadata.compression, "retrieval_count");
    const compressInvocations = numberValue(run.metadata.compression, "compress_invocations");
    const summaryCallCount = numberValue(run.metadata.compression, "summary_call_count");

    if (typeof archivedCount === "number") {
      compression.archivedCount = archivedCount;
    }
    if (typeof retrievalCount === "number") {
      compression.retrievalCount = retrievalCount;
    }
    if (typeof compressInvocations === "number") {
      compression.compressInvocations = compressInvocations;
    }
    if (typeof summaryCallCount === "number") {
      compression.summaryCallCount = summaryCallCount;
    }

    if (Object.keys(compression).length > 0) {
      view.compression = compression;
    }
  }

  return view;
}

function buildComparisonSeries(runs: BenchmarkRunRecord[]): ComparisonSeries {
  const summaries = toPerTask(runs);
  return {
    byTask: summaries.map((task) => ({
      label: task.instanceId,
      baselineTokens: task.baseline.totalTokens,
      compressedTokens: task.compressed.totalTokens,
      baselineCost: task.baseline.cost.totalCost,
      compressedCost: task.compressed.cost.totalCost
    }))
  };
}

function buildUiSummary(runs: BenchmarkRunRecord[]): UiSummary {
  const overall = compareGroupedRunsUi(runs, "overall");
  const scenarios = [...new Set(runs.map((run) => run.scenarioBucket).filter((value): value is string => value !== undefined))];

  return {
    overall,
    byScenario: scenarios.map((scenario) =>
      compareGroupedRunsUi(
        runs.filter((run) => run.scenarioBucket === scenario),
        scenario
      )
    )
  };
}

function compareGroupedRunsUi(runs: BenchmarkRunRecord[], label: string): UiComparisonMetrics {
  const baseline = runs.filter((run) => run.variantId === "baseline");
  const compressed = selectCompressedRuns(runs);
  const pairs = pairRunsByInstance(baseline, compressed);

  const baselineAggregate = aggregateRunsUi(pairs.map((pair) => pair.baseline), `${label}:baseline`);
  const compressedAggregate = aggregateRunsUi(pairs.map((pair) => pair.compressed), `${label}:compressed`);

  return {
    label,
    pairCount: pairs.length,
    baselineSuccessRate: baselineAggregate.successRate,
    compressedSuccessRate: compressedAggregate.successRate,
    successDelta: compressedAggregate.successRate - baselineAggregate.successRate,
    baselineMainTokens: baselineAggregate.mainUsage.totalTokens,
    compressedMainTokens: compressedAggregate.mainUsage.totalTokens,
    mainTokenReductionRate: ratioReduction(baselineAggregate.mainUsage.totalTokens, compressedAggregate.mainUsage.totalTokens),
    baselineSummaryTokens: baselineAggregate.summaryUsage.totalTokens,
    compressedSummaryTokens: compressedAggregate.summaryUsage.totalTokens,
    baselinePeakInputTokens: baselineAggregate.mainPeakInputTokens,
    compressedPeakInputTokens: compressedAggregate.mainPeakInputTokens,
    peakReductionRate: ratioReduction(baselineAggregate.mainPeakInputTokens, compressedAggregate.mainPeakInputTokens),
    baselineMainCost: estimateCost(baselineAggregate.mainUsage, mainPricing),
    compressedMainCost: estimateCost(compressedAggregate.mainUsage, mainPricing),
    baselineSummaryCost: estimateCost(baselineAggregate.summaryUsage, summaryPricing),
    compressedSummaryCost: estimateCost(compressedAggregate.summaryUsage, summaryPricing)
  };
}

function aggregateRunsUi(runs: BenchmarkRunRecord[], label: string): UiAggregateMetrics {
  const resolvedCount = runs.filter((run) => run.resolved === true).length;
  const breakdowns = runs.map((run) => getUsageBreakdown(run));
  const mainUsage = sumUsage(breakdowns.map((item) => item.main));
  const summaryUsage = sumUsage(breakdowns.map((item) => item.summary));
  const mainPeakInputTokens = Math.max(0, ...breakdowns.map((item) => item.mainPeakInputTokens));

  return {
    label,
    runCount: runs.length,
    resolvedCount,
    successRate: runs.length === 0 ? 0 : resolvedCount / runs.length,
    mainUsage,
    summaryUsage,
    mainPeakInputTokens
  };
}

function getUsageBreakdown(run: BenchmarkRunRecord): UsageBreakdown {
  if (!Array.isArray(run.turnUsages) || run.turnUsages.length === 0) {
    return {
      main: run.usage,
      summary: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      mainPeakInputTokens: run.peakInputTokens,
      summaryPeakInputTokens: 0
    };
  }

  const mainTurns = run.turnUsages.filter((entry) => entry.kind !== "summary");
  const summaryTurns = run.turnUsages.filter((entry) => entry.kind === "summary");

  return {
    main: sumUsage(mainTurns),
    summary: sumUsage(summaryTurns),
    mainPeakInputTokens: Math.max(run.peakInputTokens, 0, ...mainTurns.map((entry) => entry.inputTokens)),
    summaryPeakInputTokens: Math.max(0, ...summaryTurns.map((entry) => entry.inputTokens))
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

function estimateCost(
  usage: { inputTokens: number; outputTokens: number },
  modelPricing: { inputCostPer1M: number; outputCostPer1M: number }
): CostBreakdown {
  const inputCost = (usage.inputTokens / 1_000_000) * modelPricing.inputCostPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * modelPricing.outputCostPer1M;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}

function ratioReduction(baseline: number, candidate: number): number {
  if (baseline <= 0) {
    return 0;
  }

  return 1 - candidate / baseline;
}

function numberValue(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function assertSafeId(id: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid benchmark id: ${id}`);
  }
}

async function serveStatic(urlPathname: string, response: import("node:http").ServerResponse<import("node:http").IncomingMessage>): Promise<void> {
  const safePath = urlPathname === "/" ? "index.html" : urlPathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(uiDir, safePath));
  if (!filePath.startsWith(uiDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

async function writeJson(
  response: import("node:http").ServerResponse<import("node:http").IncomingMessage>,
  statusCode: number,
  value: unknown
): Promise<void> {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}

function contentType(filename: string): string {
  if (filename.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filename.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filename.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filename.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

interface BenchmarkListItem {
  id: string;
  label: string;
  status: "running" | "pre-eval" | "post-eval";
  updatedAt: string;
  progress?: ProgressSnapshot;
  overall?: {
    pairCount: number;
    baselineSuccessRate: number;
    compressedSuccessRate: number;
    tokenReductionRate: number;
    peakReductionRate: number;
    baselineCost: number;
    compressedCost: number;
    baselineSummaryTokens: number;
    compressedSummaryTokens: number;
    baselineSummaryCost: number;
    compressedSummaryCost: number;
  };
}

interface BenchmarkDetail {
  id: string;
  label: string;
  updatedAt: string;
  status: "running" | "pre-eval" | "post-eval";
  summary?: UiSummary;
  tasks: TaskComparison[];
  comparison: ComparisonSeries;
  live?: LiveBenchmarkView;
}

interface TaskComparison {
  instanceId: string;
  repo: string;
  scenarioBucket: string;
  baseline: VariantTaskView;
  compressed: VariantTaskView;
  tokenReductionRate: number;
  inputReductionRate: number;
  peakReductionRate: number;
  costReductionRate: number;
}

interface VariantTaskView {
  runId: string;
  resolved: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  peakInputTokens: number;
  cost: CostBreakdown;
  summary?: string;
  submissionStatus?: string;
  apiCalls?: number;
  summaryUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  summaryCost?: CostBreakdown;
  compression?: {
    archivedCount?: number;
    retrievalCount?: number;
    compressInvocations?: number;
    summaryCallCount?: number;
  };
  turns?: Array<{
    inputTokens: number;
    outputTokens: number;
    kind: "response" | "summary";
  }>;
}

interface ComparisonSeries {
  byTask: Array<{
    label: string;
    baselineTokens: number;
    compressedTokens: number;
    baselineCost: number;
    compressedCost: number;
  }>;
}

interface UiAggregateMetrics {
  label: string;
  runCount: number;
  resolvedCount: number;
  successRate: number;
  mainUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  summaryUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  mainPeakInputTokens: number;
}

interface UiComparisonMetrics {
  label: string;
  pairCount: number;
  baselineSuccessRate: number;
  compressedSuccessRate: number;
  successDelta: number;
  baselineMainTokens: number;
  compressedMainTokens: number;
  mainTokenReductionRate: number;
  baselineSummaryTokens: number;
  compressedSummaryTokens: number;
  baselinePeakInputTokens: number;
  compressedPeakInputTokens: number;
  peakReductionRate: number;
  baselineMainCost: CostBreakdown;
  compressedMainCost: CostBreakdown;
  baselineSummaryCost: CostBreakdown;
  compressedSummaryCost: CostBreakdown;
}

interface UiSummary {
  overall: UiComparisonMetrics;
  byScenario: UiComparisonMetrics[];
}

interface ProgressSnapshot {
  status: "running" | "completed";
  completedRuns: number;
  totalRuns: number;
  currentRunId: string | null;
  lastFinishedRunId: string | null;
  startedAt: string;
  percentComplete: number;
  updatedAt: string;
}

interface LiveBenchmarkView {
  progress: ProgressSnapshot;
  tasks: LiveTaskView[];
}

interface LiveTaskView {
  instanceId: string;
  repo: string;
  variants: Array<{
    variantId: string;
    runId: string;
    totalTokens: number;
    peakInputTokens: number;
    submissionStatus: string;
    resolved?: boolean;
  }>;
}

interface UsageBreakdown {
  main: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  summary: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  mainPeakInputTokens: number;
  summaryPeakInputTokens: number;
}

// Priority order for picking which non-baseline variant is "the compressed one".
// Earlier entries win. Falls back to any non-baseline variant if none match.
const COMPRESSED_VARIANT_PRIORITY: Array<BenchmarkRunRecord["variantId"]> = [
  "thresholded-hybrid",
  "tool-only",
  "compressed"
];

function selectCompressedRuns(runs: BenchmarkRunRecord[]): BenchmarkRunRecord[] {
  const nonBaseline = runs.filter((run) => run.variantId !== "baseline");
  const available = new Set(nonBaseline.map((run) => run.variantId));
  const chosen = COMPRESSED_VARIANT_PRIORITY.find((v) => available.has(v));
  return chosen ? nonBaseline.filter((run) => run.variantId === chosen) : nonBaseline;
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
