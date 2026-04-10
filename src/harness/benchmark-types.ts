import type { CompressionConfig, TokenUsage, TurnUsage } from "../types.js";

export interface BenchmarkTask {
  instanceId: string;
  repo: string;
  problemStatement: string;
  baseCommit?: string;
  hints?: string[];
  workspacePath?: string;
  workingDirectory?: string;
  dockerImage?: string;
  verifyCommands?: string[];
  testPatch?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BenchmarkVariant {
  id: "baseline" | "compressed" | "tool-only" | "decay-only" | "thresholded-hybrid";
  modelName: string;
  summarizerModel?: string;
  systemPrompt: string;
  compression?: Partial<CompressionConfig>;
}

export interface AgentRunArtifacts {
  runDir: string;
  payloadPath?: string;
  rawResultPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  trajectoryPath?: string;
  serializedPath?: string;
  compressionDebugPath?: string;
  errorPath?: string;
}

export interface AgentRunContext {
  runId: string;
  artifactDir?: string;
}

export interface AgentRunResult {
  patch: string;
  usage: TokenUsage;
  turnUsages?: TurnUsage[];
  summary?: string;
  resolved?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  artifacts?: AgentRunArtifacts;
}

export interface AgentAdapter {
  readonly name: string;
  runTask(task: BenchmarkTask, variant: BenchmarkVariant, context?: AgentRunContext): Promise<AgentRunResult>;
}

export interface BenchmarkRunRecord {
  runId: string;
  adapter: string;
  variantId: BenchmarkVariant["id"];
  instanceId: string;
  repo: string;
  modelName: string;
  evaluationModelName: string;
  patch: string;
  usage: TokenUsage;
  turnUsages: TurnUsage[];
  peakInputTokens: number;
  scenarioBucket?: string;
  summary?: string;
  resolved?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  artifacts?: AgentRunArtifacts;
}

export interface SweBenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface EvaluationRecord {
  instance_id: string;
  model_name_or_path: string;
  resolved: boolean;
}

export interface PricingConfig {
  inputCostPer1M: number;
  outputCostPer1M: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export interface AggregateMetrics {
  label: string;
  runCount: number;
  resolvedCount: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  peakInputTokens: number;
  estimatedCost: CostBreakdown;
  mainInputTokens: number;
  mainOutputTokens: number;
  mainTotalTokens: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryTotalTokens: number;
  mainPeakInputTokens: number;
  mainEstimatedCost: CostBreakdown;
  summaryEstimatedCost: CostBreakdown;
}

export interface ComparisonMetrics {
  label: string;
  pairCount: number;
  baselineSuccessRate: number;
  compressedSuccessRate: number;
  successDelta: number;
  baselineTotalTokens: number;
  compressedTotalTokens: number;
  tokenReductionRate: number;
  baselinePeakInputTokens: number;
  compressedPeakInputTokens: number;
  peakReductionRate: number;
  baselineEstimatedCost: CostBreakdown;
  compressedEstimatedCost: CostBreakdown;
  baselineMainInputTokens: number;
  baselineMainOutputTokens: number;
  baselineMainTokens: number;
  compressedMainInputTokens: number;
  compressedMainOutputTokens: number;
  compressedMainTokens: number;
  mainTokenReductionRate: number;
  baselineSummaryInputTokens: number;
  baselineSummaryOutputTokens: number;
  baselineSummaryTokens: number;
  compressedSummaryInputTokens: number;
  compressedSummaryOutputTokens: number;
  compressedSummaryTokens: number;
  baselineMainPeakInputTokens: number;
  compressedMainPeakInputTokens: number;
  mainPeakReductionRate: number;
  baselineMainEstimatedCost: CostBreakdown;
  compressedMainEstimatedCost: CostBreakdown;
  baselineSummaryEstimatedCost: CostBreakdown;
  compressedSummaryEstimatedCost: CostBreakdown;
}

export interface BenchmarkSummary {
  overall: ComparisonMetrics;
  byScenario: ComparisonMetrics[];
}
