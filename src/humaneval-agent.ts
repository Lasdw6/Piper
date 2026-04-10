import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import { VercelAICompressionRuntime } from "./vercel-ai-runtime.js";
import type { AgentRunResult, BenchmarkTask, BenchmarkVariant } from "./harness/benchmark-types.js";
import type { TurnUsage } from "./types.js";

interface Payload {
  task: BenchmarkTask;
  variant: BenchmarkVariant;
}

interface HumanEvalMetadata {
  taskId: string;
  prompt: string;
  test: string;
  entryPoint: string;
}

interface AttemptRecord {
  attempt: number;
  completionPath: string;
  execPath: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_ATTEMPTS = 5;
const RESPONSE_MAX_TOKENS = 900;

async function main(): Promise<void> {
  process.loadEnvFile?.();
  const taskPath = process.env.BENCHMARK_TASK_PATH;
  const resultPath = process.env.BENCHMARK_RESULT_PATH;
  if (!taskPath || !resultPath) {
    throw new Error("BENCHMARK_TASK_PATH and BENCHMARK_RESULT_PATH are required.");
  }

  const payload = JSON.parse(await readFile(taskPath, "utf8")) as Payload;
  const metadata = parseMetadata(payload.task);
  const artifactDir = path.dirname(resultPath);
  await mkdir(artifactDir, { recursive: true });

  const provider = createOpenAI({
    apiKey: requiredEnv("OPENAI_API_KEY")
  });

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "humaneval-agent-"));
  const attempts: AttemptRecord[] = [];
  let resolved = false;
  let finalCompletion = "";
  let finalFailure = "";
  const baselineTurns: TurnUsage[] = [];

  try {
    const systemPrompt = buildSystemPrompt(metadata);

    if (payload.variant.id === "compressed") {
      const runtimeConfig = {
        systemPrompt,
        mainModel: payload.variant.modelName,
        compression: {
          maxContextTokens: payload.variant.compression?.maxContextTokens ?? 1400,
          compressAtRatio: payload.variant.compression?.compressAtRatio ?? 0.8,
          mode: payload.variant.compression?.mode ?? "hybrid",
          phaseCompressionEnabled: payload.variant.compression?.phaseCompressionEnabled ?? true,
          messageDecayEnabled: payload.variant.compression?.messageDecayEnabled ?? true,
          retrievalTopK: payload.variant.compression?.retrievalTopK ?? 2,
          keepPrefixMessages: payload.variant.compression?.keepPrefixMessages ?? 1,
          keepSuffixMessages: payload.variant.compression?.keepSuffixMessages ?? 2,
          fibonacciBuckets: payload.variant.compression?.fibonacciBuckets ?? [1, 2, 3, 5, 8, 13]
        },
        dbPath: path.join(artifactDir, "humaneval-memory.sqlite")
      } as const;
      const runtime = new VercelAICompressionRuntime(
        payload.variant.summarizerModel
          ? {
              ...runtimeConfig,
              summarizerModel: payload.variant.summarizerModel
            }
          : runtimeConfig
      );

      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const userPrompt = buildAttemptPrompt(attempt, finalFailure);
          const response = await runtime.respond(userPrompt, {
            phaseId: `attempt_${attempt}`,
            tags: [metadata.taskId],
            retrievalQuery: `${metadata.entryPoint} ${metadata.taskId.replaceAll("/", " ")}`
          });
          const completion = normalizeCompletion(response.text, metadata.prompt);
          finalCompletion = completion;

          const attemptResult = await executeHumanEval(workspaceDir, metadata, completion, attempt);
          attempts.push(attemptResult);
          finalFailure = truncateFailure(attemptResult);

          if (attemptResult.success) {
            resolved = true;
            break;
          }
        }

        const usage = runtime.getUsage();
        await persistAttemptArtifacts(artifactDir, attempts, metadata, finalCompletion);
        await writeResult(resultPath, {
          patch: finalCompletion,
          resolved,
          usage: usage.totals,
          turnUsages: usage.turns,
          summary: resolved ? "HumanEval task passed." : "HumanEval task failed.",
          metadata: buildMetadata(
            metadata,
            attempts,
            resolved,
            usage.turns.some((turn) => turn.kind === "summary")
          )
        });
      } finally {
        runtime.close();
      }
      return;
    }

    const systemMessages = [{ role: "system" as const, content: systemPrompt }];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const userPrompt = buildAttemptPrompt(attempt, finalFailure);
      const result = await generateText({
        model: provider(payload.variant.modelName),
        messages: [...systemMessages, { role: "user", content: userPrompt }],
        temperature: 0,
        maxTokens: RESPONSE_MAX_TOKENS
      });

      baselineTurns.push({
        turnId: `response_${attempt}`,
        phaseId: `attempt_${attempt}`,
        model: payload.variant.modelName,
        kind: "response",
        inputTokens: result.usage.promptTokens ?? 0,
        outputTokens: result.usage.completionTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0
      });

      const completion = normalizeCompletion(result.text, metadata.prompt);
      finalCompletion = completion;

      const attemptResult = await executeHumanEval(workspaceDir, metadata, completion, attempt);
      attempts.push(attemptResult);
      finalFailure = truncateFailure(attemptResult);

      if (attemptResult.success) {
        resolved = true;
        break;
      }
    }

    await persistAttemptArtifacts(artifactDir, attempts, metadata, finalCompletion);
    await writeResult(resultPath, {
      patch: finalCompletion,
      resolved,
      usage: sumTurns(baselineTurns),
      turnUsages: baselineTurns,
      summary: resolved ? "HumanEval task passed." : "HumanEval task failed.",
      metadata: buildMetadata(metadata, attempts, resolved, false)
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function parseMetadata(task: BenchmarkTask): HumanEvalMetadata {
  const metadata = task.metadata as Record<string, unknown> | undefined;
  const taskId = typeof metadata?.taskId === "string" ? metadata.taskId : task.instanceId;
  const prompt = typeof metadata?.prompt === "string" ? metadata.prompt : "";
  const test = typeof metadata?.test === "string" ? metadata.test : "";
  const entryPoint = typeof metadata?.entryPoint === "string" ? metadata.entryPoint : "";
  if (!prompt || !test || !entryPoint) {
    throw new Error(`Task ${task.instanceId} is missing HumanEval metadata.`);
  }
  return { taskId, prompt, test, entryPoint };
}

function buildSystemPrompt(metadata: HumanEvalMetadata): string {
  return [
    "You solve HumanEval Python programming tasks.",
    "Return only raw Python code that should be appended to the provided prompt.",
    "Do not use markdown fences.",
    "Do not explain your answer.",
    "The prompt below is immutable and must remain valid Python after your completion is appended.",
    `Task ID: ${metadata.taskId}`,
    `Entry point: ${metadata.entryPoint}`,
    "",
    "Prompt:",
    metadata.prompt
  ].join("\n");
}

function buildAttemptPrompt(attempt: number, previousFailure: string): string {
  if (attempt === 1) {
    return "Produce the Python completion now.";
  }

  return [
    "Previous attempt failed.",
    "Return a revised Python completion only.",
    "Failure summary:",
    previousFailure
  ].join("\n");
}

async function executeHumanEval(
  workspaceDir: string,
  metadata: HumanEvalMetadata,
  completion: string,
  attempt: number
): Promise<AttemptRecord> {
  const completionPath = path.join(workspaceDir, `completion_${attempt}.py`);
  const execPath = path.join(workspaceDir, `exec_${attempt}.py`);
  const program = [
    metadata.prompt,
    completion,
    "",
    metadata.test,
    "",
    `check(${metadata.entryPoint})`,
    "print('HUMANEVAL_PASS')"
  ].join("\n");

  await writeFile(completionPath, completion, "utf8");
  await writeFile(execPath, program, "utf8");

  const execution = await runPython(execPath);
  return {
    attempt,
    completionPath,
    execPath,
    success: execution.exitCode === 0 && execution.stdout.includes("HUMANEVAL_PASS"),
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr
  };
}

function runPython(scriptPath: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [scriptPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function normalizeCompletion(text: string, prompt: string): string {
  let value = text.replace(/\r\n/g, "\n");
  if (value.trimStart().startsWith("```")) {
    value = value.trimStart().replace(/^```[a-zA-Z]*\s*/, "");
    value = value.replace(/\s*```[\t ]*$/m, "");
  }

  if (value.startsWith(prompt)) {
    value = value.slice(prompt.length);
  }

  return value.trimEnd();
}

function truncateFailure(attempt: AttemptRecord): string {
  const stderr = attempt.stderr.trim();
  const stdout = attempt.stdout.trim();
  const detail = stderr || stdout || `exit code ${attempt.exitCode ?? -1}`;
  return detail.length > 1500 ? `${detail.slice(0, 1500)}...` : detail;
}

async function persistAttemptArtifacts(
  artifactDir: string,
  attempts: AttemptRecord[],
  metadata: HumanEvalMetadata,
  finalCompletion: string
): Promise<void> {
  await writeFile(path.join(artifactDir, "attempts.json"), JSON.stringify(attempts, null, 2), "utf8");
  await writeFile(path.join(artifactDir, "prompt.py"), metadata.prompt, "utf8");
  await writeFile(path.join(artifactDir, "final_completion.py"), finalCompletion, "utf8");
}

function buildMetadata(
  metadata: HumanEvalMetadata,
  attempts: AttemptRecord[],
  resolved: boolean,
  compressionActivated: boolean
): Record<string, string | number | boolean | null> {
  const last = attempts.at(-1);
  return {
    benchmark: "humaneval",
    taskId: metadata.taskId,
    entryPoint: metadata.entryPoint,
    attempts: attempts.length,
    lastExitCode: last?.exitCode ?? null,
    compressionActivated,
    resolved
  };
}

function sumTurns(turns: TurnUsage[]) {
  return turns.reduce(
    (acc, turn) => ({
      inputTokens: acc.inputTokens + turn.inputTokens,
      outputTokens: acc.outputTokens + turn.outputTokens,
      totalTokens: acc.totalTokens + turn.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

async function writeResult(resultPath: string, result: AgentRunResult): Promise<void> {
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

void main();
