import path from "node:path";

import { BenchmarkRunner } from "./benchmark.js";
import type { BenchmarkTask, BenchmarkVariant, PricingConfig } from "./benchmark-types.js";
import { CommandAgentAdapter } from "./command-agent-adapter.js";
import { readJsonlFile } from "./jsonl.js";
import { MiniSweAgentAdapter } from "./mini-swe-agent-adapter.js";
import { MockAgentAdapter } from "./mock-agent-adapter.js";

async function main(): Promise<void> {
  process.loadEnvFile?.();
  const [command, ...args] = process.argv.slice(2);

  if (command === "run") {
    const tasksPath = requiredFlag(args, "--tasks");
    const outputDir = flagValue(args, "--out") ?? "artifacts/benchmark";
    const agentKind = flagValue(args, "--agent") ?? "mock";
    const modelName = flagValue(args, "--model") ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";
    const summarizerModel =
      flagValue(args, "--summarizer-model") ?? process.env.BENCHMARK_SUMMARIZER_MODEL ?? "gpt-4.1-mini";
    const maxContextTokens = Number(flagValue(args, "--max-context-tokens") ?? process.env.BENCHMARK_MAX_CONTEXT_TOKENS ?? "10000");
    const tasks = await readJsonlFile<BenchmarkTask>(tasksPath);
    const pricing = parsePricing(args);

    const adapter =
      agentKind === "mini-swe-agent"
        ? new MiniSweAgentAdapter(
            flagValue(args, "--python")
              ? {
                  pythonExecutable: requiredFlag(args, "--python")
                }
              : {}
          )
        : agentKind === "command"
        ? new CommandAgentAdapter(requiredFlag(args, "--cmd"), collectFlagValues(args, "--cmd-arg"))
        : new MockAgentAdapter();

    const baseline: BenchmarkVariant = {
      id: "baseline",
      modelName,
      systemPrompt: "Solve the task without context compression."
    };
    const compressed: BenchmarkVariant = {
      id: "compressed",
      modelName,
      summarizerModel,
      systemPrompt: "Solve the task with live context compression and retrieval.",
      compression: {
        mode: "hybrid",
        maxContextTokens,
        compressAtRatio: 0.8,
        phaseCompressionEnabled: true,
        messageDecayEnabled: true,
        summarizerModel
      }
    };

    const runner = new BenchmarkRunner(adapter, pricing);
    const runs = await runner.runPaired(tasks, outputDir, [baseline, compressed]);
    console.log(`Wrote ${runs.length} run records to ${path.resolve(outputDir)}`);
    return;
  }

  if (command === "merge-eval") {
    const runsPath = requiredFlag(args, "--runs");
    const evalPath = requiredFlag(args, "--eval");
    const outputDir = flagValue(args, "--out") ?? path.dirname(runsPath);
    const pricing = parsePricing(args);
    const runner = new BenchmarkRunner(new MockAgentAdapter(), pricing);
    const summary = await runner.mergeEvaluation(runsPath, evalPath, outputDir);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printUsage();
}

function parsePricing(args: string[]): PricingConfig {
  return {
    inputCostPer1M: Number(flagValue(args, "--input-cost") ?? "0.8"),
    outputCostPer1M: Number(flagValue(args, "--output-cost") ?? "3.2")
  };
}

function requiredFlag(args: string[], name: string): string {
  const value = flagValue(args, name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }

  return value;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function collectFlagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value) {
        values.push(value);
      }
    }
  }
  return values;
}

function printUsage(): void {
  console.log("Usage:");
  console.log(
    "  tsx src/harness/benchmark-cli.ts run --tasks <tasks.jsonl> [--agent mock|command|mini-swe-agent] [--model <main>] [--summarizer-model <summary>] [--max-context-tokens <n>] [--cmd <command>]"
  );
  console.log("  tsx src/harness/benchmark-cli.ts merge-eval --runs <runs.jsonl> --eval <eval.jsonl>");
}

void main();
